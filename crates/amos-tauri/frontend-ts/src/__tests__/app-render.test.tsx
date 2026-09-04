import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "../i18n";
import FilesApp from "../components/FilesApp";
import MapsApp from "../components/MapsApp";
import CameraApp from "../components/CameraApp";
import { MessagesApp, PhoneApp, MusicApp } from "../components/CommsApps";
import { AiApp, InterpApp } from "../components/BackendApps";
import MailApp from "../components/MailApp";
import RemindersApp from "../components/RemindersApp";
import VoiceMemosApp from "../components/VoiceMemosApp";

const wrap = (el: ReactNode) => <I18nProvider>{el}</I18nProvider>;

describe("app SSR mount smoke", () => {
  const cases: [string, ReactNode, string][] = [
    ["files", <FilesApp />, "＋ 文件夹"],
    ["maps", <MapsApp />, "📍"],
    ["camera", <CameraApp />, "🏔️"],
    ["messages", <MessagesApp />, "➤"],
    ["phone", <PhoneApp />, "⌫"],
    ["music", <MusicApp />, "▶"],
    ["ai", <AiApp />, "🤖"],
    ["interpreter", <InterpApp />, "🌐"],
    ["mail", <MailApp />, "已发送"],
    ["reminders", <RemindersApp />, "新提醒事项"],
    ["vmemos", <VoiceMemosApp />, "轻点红点开始录音"],
  ];
  for (const [name, el, marker] of cases) {
    test(`${name} renders without throwing`, () => {
      expect(renderToString(wrap(el))).toContain(marker);
    });
  }
});
