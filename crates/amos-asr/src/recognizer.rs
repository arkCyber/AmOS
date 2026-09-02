//! The [`StreamingRecognizer`] abstraction and a deterministic mock.

use amos_int::language::Language;

/// An incremental recognition hypothesis for the current utterance.
///
/// `stable` is the committed prefix that will not change; `text` is the whole
/// provisional string (stable + unstable tail).
#[derive(Clone, Debug, PartialEq)]
pub struct Hypothesis {
    pub stable: String,
    pub text: String,
    pub lang: Option<Language>,
}

/// An incremental (streaming) speech recognizer.
///
/// Implementors accumulate PCM samples and expose a growing hypothesis plus an
/// endpoint signal. The [`crate::AsrPipeline`] turns these into
/// `AsrEvent::Partial`/`Final`.
pub trait StreamingRecognizer: Send + Sync {
    /// Reset for a new utterance.
    fn reset(&mut self);

    /// Feed a chunk of mono PCM (16 kHz f32). Returns an updated hypothesis, or
    /// `None` if recognition did not change.
    fn push_samples(&mut self, samples: &[f32]) -> Option<Hypothesis>;

    /// Whether the recognizer considers the current utterance complete (VAD /
    /// model endpoint). The pipeline consumes this exactly once per utterance.
    fn is_endpoint(&self) -> bool;

    /// Force-finalize the current utterance and return its full text.
    fn finalize(&mut self) -> String;
}

/// Deterministic [`StreamingRecognizer`] for tests and offline demos.
///
/// Given a list of words, it emits a partial after every
/// [`MockStreamingRecognizer::samples_per_partial`] samples (growing by one
/// word), and signals an endpoint once it has emitted
/// [`MockStreamingRecognizer::endpoint_after`] words.
pub struct MockStreamingRecognizer {
    words: Vec<String>,
    samples_per_partial: usize,
    endpoint_after: usize,
    lang: Language,
    samples: usize,
    emitted: usize,
    finalized: bool,
}

impl MockStreamingRecognizer {
    /// Recognizer that grows `words` (e.g. `["你", "好", "，Amos"]`) and signals
    /// an endpoint after `endpoint_after` words.
    pub fn new(words: impl IntoIterator<Item = impl Into<String>>, endpoint_after: usize) -> Self {
        Self {
            words: words.into_iter().map(Into::into).collect(),
            samples_per_partial: 160, // one 10 ms frame per partial
            endpoint_after,
            lang: Language::new("zh"),
            samples: 0,
            emitted: 0,
            finalized: false,
        }
    }

    /// Number of accumulated samples between partial emissions.
    pub fn with_samples_per_partial(mut self, n: usize) -> Self {
        self.samples_per_partial = n.max(1);
        self
    }

    /// The detected source language reported on each hypothesis.
    pub fn with_lang(mut self, lang: impl Into<Language>) -> Self {
        self.lang = lang.into();
        self
    }
}

impl StreamingRecognizer for MockStreamingRecognizer {
    fn reset(&mut self) {
        self.samples = 0;
        self.emitted = 0;
        self.finalized = false;
    }

    fn push_samples(&mut self, samples: &[f32]) -> Option<Hypothesis> {
        self.samples += samples.len();
        if samples.is_empty() {
            return None;
        }
        let n = (self.samples / self.samples_per_partial).min(self.words.len());
        if n <= self.emitted {
            return None;
        }
        self.emitted = n;
        let text = self.words[..n].join("");
        let stable = self.words[..n.saturating_sub(1)].join("");
        Some(Hypothesis {
            stable,
            text,
            lang: Some(self.lang.clone()),
        })
    }

    fn is_endpoint(&self) -> bool {
        !self.finalized && self.emitted >= self.endpoint_after
    }

    fn finalize(&mut self) -> String {
        self.finalized = true;
        self.words[..self.endpoint_after.min(self.words.len())].join("")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recognizer() -> MockStreamingRecognizer {
        MockStreamingRecognizer::new(["你", "好", "，Amos"], 3)
    }

    #[test]
    fn partials_grow_word_by_word() {
        let mut r = recognizer();
        // 160 samples per partial.
        let p1 = r.push_samples(&vec![0.0; 160]).unwrap();
        assert_eq!(p1.text, "你");
        assert_eq!(p1.stable, "");
        assert!(!r.is_endpoint());

        let p2 = r.push_samples(&vec![0.0; 160]).unwrap();
        assert_eq!(p2.text, "你好");
        assert_eq!(p2.stable, "你");
    }

    #[test]
    fn endpoint_and_finalize() {
        let mut r = recognizer();
        r.push_samples(&vec![0.0; 160]);
        r.push_samples(&vec![0.0; 160]);
        r.push_samples(&vec![0.0; 160]);
        assert!(r.is_endpoint());
        assert_eq!(r.finalize(), "你好，Amos");
        assert!(!r.is_endpoint(), "endpoint is one-shot until reset");
    }

    #[test]
    fn reset_starts_fresh() {
        let mut r = recognizer();
        r.push_samples(&vec![0.0; 160]);
        r.push_samples(&vec![0.0; 160]);
        r.push_samples(&vec![0.0; 160]);
        r.finalize();
        r.reset();
        assert!(!r.is_endpoint());
        assert_eq!(r.push_samples(&vec![0.0; 160]).unwrap().text, "你");
    }
}
