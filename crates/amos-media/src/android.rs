//! Real Android MediaStore backend for the media domain — feature-gated `android`.
//!
//! On the Android System UI APK, shared external storage (`DCIM`, `Pictures`,
//! `Download`, `Recordings`, …) is owned by Android **MediaStore**, reachable only
//! from a process holding the app `Context` + `ContentResolver` (the System UI
//! Tauri APK, never the headless daemon). Rust cannot touch `ContentResolver`, so
//! queries/inserts run in a Kotlin `MediaStoreGlue` and cross back over JNI. This
//! module is that Rust side — every round-trip is **String ↔ String**:
//!
//! * `listCollection(dirTag)` → glue returns a JSON array of [`MediaItem`].
//! * `saveCollection(dir, name, kind, mime, dataB64)` → glue returns a JSON
//!   [`MediaItem`] or `{"error":"…"}`.
//! * `loadContent(uri)` → glue returns `{"base64":"…"}` or `{"error":"…"}`.
//!
//! The provider holds a `JavaVM` + a global ref to the glue. Runtime needs a real
//! Android VM; on host this only has to **compile** (`cargo check -p amos-media
//! --features android`). Nothing is faked: if the glue is missing / a call throws,
//! each method returns an explicit [`MediaError::Provider`].

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use jni::objects::{GlobalRef, JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};
use serde_json::Value as Json;

use crate::error::{MediaError, Result};
use crate::mapping::mime_for;
use crate::provider::MediaProvider;
use crate::spec::{MediaItem, MediaKind, StandardDir};

/// Map a JNI error into a [`MediaError::Provider`].
fn jerr(e: jni::errors::Error) -> MediaError {
    MediaError::Provider(format!("android mediastore glue error: {e}"))
}

/// `Send + Sync` handle to the Kotlin `MediaStoreGlue` bridge instance.
struct AndroidGlue(GlobalRef);

// SAFETY: a JNI global ref outlives the creating env and is VM-global; every
// method re-attaches the calling thread before touching it.
unsafe impl Send for AndroidGlue {}
// SAFETY: access always happens on an attached thread.
unsafe impl Sync for AndroidGlue {}

/// The real Android backend behind the [`MediaProvider`] seam.
pub struct AndroidMediaProvider {
    vm: JavaVM,
    glue: AndroidGlue,
}

impl AndroidMediaProvider {
    /// Attach to the Kotlin `MediaStoreGlue` instance. `env` is only used to
    /// promote the glue object into a global ref.
    pub fn new(vm: JavaVM, env: &JNIEnv<'_>, glue: JObject<'_>) -> Result<Self> {
        Ok(Self {
            vm,
            glue: AndroidGlue(env.new_global_ref(glue).map_err(jerr)?),
        })
    }

    /// Attach the current thread to the VM for one call.
    fn attach(&self) -> Result<JNIEnv<'_>> {
        self.vm.attach_current_thread_permanently().map_err(jerr)
    }
}
impl MediaProvider for AndroidMediaProvider {
    fn name(&self) -> &'static str {
        "android-mediastore"
    }

    fn available_collections(&self) -> Vec<StandardDir> {
        // The collections a MediaStore device can enumerate (not the virtual root).
        vec![
            StandardDir::Camera,
            StandardDir::Screenshots,
            StandardDir::Pictures,
            StandardDir::Download,
            StandardDir::Recordings,
            StandardDir::Movies,
            StandardDir::Music,
        ]
    }

    fn list(&self, dir: StandardDir) -> Result<Vec<MediaItem>> {
        let mut env = self.attach()?;
        let glue = self.glue.0.as_obj();
        let jtag = env.new_string(dir.tag()).map_err(jerr)?;
        let jarg: JObject = jtag.into();
        let out = env
            .call_method(
                glue,
                "listCollection",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&jarg)],
            )
            .map_err(jerr)?;
        let jstr = JString::from(out.l().map_err(jerr)?);
        let json: String = env.get_string(&jstr).map_err(jerr)?.into();
        serde_json::from_str(&json)
            .map_err(|e| MediaError::Provider(format!("glue list unparseable: {e}")))
    }
    fn save(
        &self,
        dir: StandardDir,
        kind: MediaKind,
        name: &str,
        data: &[u8],
    ) -> Result<MediaItem> {
        let mut env = self.attach()?;
        let glue = self.glue.0.as_obj();
        let mk = |s: &str| env.new_string(s).map_err(jerr);
        let tag: JObject = mk(dir.tag())?.into();
        let nm: JObject = mk(name)?.into();
        let kd: JObject = mk(kind.as_str())?.into();
        let mi: JObject = mk(mime_for(kind))?.into();
        let b64: JObject = mk(&STANDARD.encode(data))?.into();
        let args = [
            JValue::Object(&tag),
            JValue::Object(&nm),
            JValue::Object(&kd),
            JValue::Object(&mi),
            JValue::Object(&b64),
        ];
        let out = env
            .call_method(
                glue,
                "saveCollection",
                "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &args,
            )
            .map_err(jerr)?;
        let jstr = JString::from(out.l().map_err(jerr)?);
        let json: String = env.get_string(&jstr).map_err(jerr)?.into();
        match serde_json::from_str::<MediaItem>(&json) {
            Ok(item) => Ok(item),
            Err(_) => Err(glue_err(&json).unwrap_or_else(|| {
                MediaError::Provider("glue save returned an unparseable reply".to_string())
            })),
        }
    }

    fn load(&self, item: &MediaItem) -> Result<Vec<u8>> {
        let mut env = self.attach()?;
        let glue = self.glue.0.as_obj();
        let juri = env.new_string(&item.uri).map_err(jerr)?;
        let jarg: JObject = juri.into();
        let out = env
            .call_method(
                glue,
                "loadContent",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&jarg)],
            )
            .map_err(jerr)?;
        let jstr = JString::from(out.l().map_err(jerr)?);
        let json: String = env.get_string(&jstr).map_err(jerr)?.into();
        let v: Json = serde_json::from_str(&json)
            .map_err(|e| MediaError::Provider(format!("glue load unparseable: {e}")))?;
        if let Some(b64) = v.get("base64").and_then(|x| x.as_str()) {
            STANDARD
                .decode(b64)
                .map_err(|e| MediaError::Provider(format!("glue load bad base64: {e}")))
        } else if let Some(msg) = v.get("error").and_then(|x| x.as_str()) {
            Err(MediaError::Provider(msg.to_string()))
        } else {
            Err(MediaError::Provider(
                "glue load returned an unknown reply".to_string(),
            ))
        }
    }
}

/// If `json` is `{"error":"…"}`, return that [`MediaError::Provider`].
fn glue_err(json: &str) -> Option<MediaError> {
    let v: Json = serde_json::from_str(json).ok()?;
    v.get("error")
        .and_then(|x| x.as_str())
        .map(|s| MediaError::Provider(s.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glue_err_extracts_an_error_payload() {
        let e = glue_err(r#"{"error":"no such uri"}"#).unwrap();
        assert!(matches!(e, MediaError::Provider(m) if m == "no such uri"));
        assert!(glue_err("{not json}").is_none());
        assert!(glue_err(r#"{"id":"x"}"#).is_none());
    }
}
