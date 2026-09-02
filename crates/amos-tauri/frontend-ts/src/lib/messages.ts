export interface Msg {
  from: "me" | "them";
  text: string;
  ts: number;
}

export const MSG_KEY = "amos.messages";

export function seedMessages(now: number): Msg[] {
  return [
    { from: "them", text: "你好！Amos 系统感觉怎么样？", ts: now - 3000 },
    { from: "me", text: "很棒，像 iOS 一样顺滑。", ts: now - 2000 },
    { from: "them", text: "要不要试试 AI 应用？", ts: now - 1000 },
  ];
}

/** Append an outgoing message (iMessage-style, chronological). */
export function appendMessage(list: Msg[], text: string, now: number): Msg[] {
  return [...list, { from: "me", text, ts: now }];
}
