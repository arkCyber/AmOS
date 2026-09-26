# -*- coding: utf-8 -*-
content = open('CHANGELOG.md', encoding='utf-8').read()
new_entry = '''- **`interpret_*` 命令的错误返回从 `Result<T, String>` 迁移到 `AmosResult<T>` + 命名 typed `ErrorCode` 枚举，前端按 reason code 渲染本地化提示（REQ-A461；FMEA F-SH-646，2026-09-25，起点是「按照航空航天级别标准，帮助我审计与补全代码，注意错误处理功能」）：`error.rs` 新增 6 个 ErrorCode（`InterpretNoActive`/`InterpretSessionIdMismatch`/`InterpretTextTooLong`/`InterpretAudioTooLarge`/`InterpretSessionFailed`/`InterpretChannelFailed`），同步更新 `as_str()`/`ALL_VARIANTS`/`FROZEN_VARIANT_COUNT`（128→134）/group 测试；`interpret.rs` 全部 7 条 Tauri 命令的 `Err` 改用 `AmosError::new(ErrorCode::…)`；`backend.ts` 的 `BridgeDiag.command-failed` 新增 `code?: string` 字段并在 catch 分支提取；`InterpApp.svelte` 新增 `statusForInterpError` 工具按 typed code 渲染 `interp.err.*` i18n 键，4 处 `status = t("interp.XFailed")` 换用该工具；i18n 新增 6 个 reason-specific 键（zh.ts ∕ en.ts）。discriminant 测试 7 例验证各 ErrorCode；负控：把 `Err(AmosError::new)` 改回 `Err("...".into())` → 编译错误（`code()` 方法不存在）；`cargo test -p amos-tauri --lib interpret::tests` 12/12 通过；`cargo test -p amos-tauri --lib error::tests::wire_codes_are_frozen` 通过；`bun run tsc --noEmit` 0 错误。
'''
lines = content.split('\n')
# Find the line after the first **bold** line (after "# Changelog\nAll notable...")
# Insert after line 6 (the last leading entry line before the first H2)
# The changelog has leading metadata, then entries starting with "- **"
# We insert after the first such entry (the Podcasts one on line 7)
lines.insert(6, new_entry)
open('CHANGELOG.md', 'w', encoding='utf-8').write('\n'.join(lines))
print('Appended REQ-A461 entry to CHANGELOG.md after line 6')
