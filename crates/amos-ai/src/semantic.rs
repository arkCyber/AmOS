//! Semantic intent engine: turns a user prompt into a structured [`UiCard`]
//! so the AI agent can *drive* the Tauri UI (语义中枢 → 像素表面) instead of only
//! returning raw text.
//!
//! This is a deterministic, keyword-based MVP over the mock inference engine.
//! Swap this for a real model's structured output (function-calling / JSON mode)
//! without touching the transport or UI layers — the wire contract is unchanged.

use amos_proto::ai_agent::{UiCard, UiField};

/// Detect a structured intent from a prompt and build the corresponding card.
/// Returns `None` when no structured intent is recognized (the caller falls
/// back to plain text streaming).
pub fn detect(prompt: &str) -> Option<UiCard> {
    let p = prompt.to_lowercase();

    if contains_any(&p, &["天气", "气温", "温度"]) {
        return Some(weather_card());
    }
    if contains_any(&p, &["播放", "音乐", "放歌", "来首歌", "歌"]) {
        return Some(media_card());
    }
    if contains_any(&p, &["笔记", "记事", "总结", "记录"]) {
        return Some(note_card());
    }
    if contains_any(&p, &["钱包", "余额", "资产", "web3", "区块链"]) {
        return Some(wallet_card());
    }
    if contains_any(&p, &["打开", "启动", "打开应用"]) {
        return Some(action_card(prompt));
    }
    None
}

fn contains_any(p: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| p.contains(n))
}

fn field(key: &str, value: &str) -> UiField {
    UiField {
        key: key.to_string(),
        value: value.to_string(),
    }
}

fn card(
    kind: &str,
    title: &str,
    subtitle: &str,
    fields: Vec<UiField>,
    actions: Vec<&str>,
) -> UiCard {
    UiCard {
        kind: kind.to_string(),
        title: title.to_string(),
        subtitle: subtitle.to_string(),
        fields,
        actions: actions.into_iter().map(|s| s.to_string()).collect(),
    }
}

fn weather_card() -> UiCard {
    card(
        "weather",
        "今日天气",
        "北京 · 实时",
        vec![
            field("天气", "多云转晴"),
            field("气温", "26° / 18°"),
            field("湿度", "58%"),
        ],
        vec!["打开地图"],
    )
}

fn media_card() -> UiCard {
    card(
        "media",
        "播放《晨光》",
        "Amos 合成器 · 正在准备",
        vec![field("时长", "24 秒"), field("格式", "Web Audio 合成")],
        vec!["打开音乐"],
    )
}

fn note_card() -> UiCard {
    card(
        "note",
        "笔记助手",
        "已整理你的记录",
        vec![field("条数", "3"), field("最近", "今天 09:12")],
        vec!["打开笔记"],
    )
}

fn wallet_card() -> UiCard {
    card(
        "wallet",
        "Amos 钱包",
        "0x7f3a…c91e · 本地托管",
        vec![field("余额", "0.00 AMOS"), field("网络", "本地 · 离线")],
        vec!["打开设置"],
    )
}

fn action_card(prompt: &str) -> UiCard {
    // Extract a likely app target from common phrases.
    let target = if contains_any(&prompt.to_lowercase(), &["音乐", "歌"]) {
        "打开音乐"
    } else if contains_any(&prompt.to_lowercase(), &["地图", "导航"]) {
        "打开地图"
    } else if contains_any(&prompt.to_lowercase(), &["相册", "照片"]) {
        "打开相册"
    } else if contains_any(&prompt.to_lowercase(), &["设置"]) {
        "打开设置"
    } else if contains_any(&prompt.to_lowercase(), &["文件"]) {
        "打开文件"
    } else {
        "打开应用"
    };
    card(
        "action",
        "执行操作",
        "根据指令启动应用",
        vec![field("意图", target)],
        vec![target],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weather_intent_builds_weather_card() {
        let c = detect("明天天气怎么样").expect("weather intent");
        assert_eq!(c.kind, "weather");
        assert!(!c.fields.is_empty());
    }

    #[test]
    fn music_intent_builds_media_card() {
        let c = detect("帮我播放一首歌").expect("music intent");
        assert_eq!(c.kind, "media");
        assert!(c.actions.iter().any(|a| a.contains("音乐")));
    }

    #[test]
    fn wallet_intent_builds_wallet_card() {
        let c = detect("查一下钱包余额").expect("wallet intent");
        assert_eq!(c.kind, "wallet");
    }

    #[test]
    fn open_intent_builds_action_card() {
        let c = detect("打开地图导航").expect("action intent");
        assert_eq!(c.kind, "action");
        assert!(c.actions.iter().any(|a| a.contains("地图")));
    }

    #[test]
    fn unknown_prompt_returns_none() {
        assert!(detect("你好，随便聊聊").is_none());
        assert!(detect("hello").is_none());
    }
}
