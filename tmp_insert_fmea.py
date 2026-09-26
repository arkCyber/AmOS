# -*- coding: utf-8 -*-
#!/usr/bin/env python3
content = open('docs/FMEA.md', encoding='utf-8').read()
new_row = '| F-SH-640 | `interpret_*` 命令用 `Result<T, String>` 暴露错误，前端 i18n 层无 `amos.interpret.*` 命名空间、只能硬编码英文（REQ-A461，2026-09-25）：①核实：`interpret.rs` 全部 7 条命令修前返回 `Result<T, String>`，`Err` 携带英文字面量；`zh.ts` 无 `amos.interpret.*` 键。②缺陷：与 `error.rs` typed envelope 设计方向相反。③影响：`interp.stopFailed` 等句不分原因；超长文本直接展示字节数字而非 i18n 化提示；session id 不匹配时前端 `bridgeDiag().code` 为 undefined。 | 用户可见的诚实边界缺失：无 session 时按 stop 说「守护进程拒绝」而非「没有会话」；属可诊断性缺陷（S=2 P=3 D=2 RPN=12）。 | 2 | 3 | 2 | 12 | ①`error.rs` 新增 6 个 ErrorCode：`InterpretNoActive`/`InterpretSessionIdMismatch`/`InterpretTextTooLong`/`InterpretAudioTooLarge`/`InterpretSessionFailed`/`InterpretChannelFailed`；同步更新 `as_str()`/`ALL_VARIANTS`/`FROZEN_VARIANT_COUNT`（128→134）/`group` 测试。②`interpret.rs` 全部 `Result<T, String>` → `AmosResult<T>`。③`backend.ts`：`BridgeDiag.command-failed` 新增 `code?: string`；`noteDiag` 在 catch 分支提取 code。④`InterpApp.svelte` 新增 `statusForInterpError` 工具按 code 渲染 `interp.err.*` 键；4 处换用该工具。⑤i18n 新增 6 键（zh.ts ∕ en.ts）。 | discriminant 测试 7 例验证各 ErrorCode；负控：把 `Err(AmosError::new)` 改回 `Err("...".into())` → 编译错误；`wire_codes_are_frozen` 通过；`cargo test -p amos-tauri --lib interpret::tests` 12/12 通过。 |\n'
lines = content.split('\n')
lines.insert(810, new_row)
open('docs/FMEA.md', 'w', encoding='utf-8').write('\n'.join(lines))
print('Inserted F-SH-640 after line 810')
