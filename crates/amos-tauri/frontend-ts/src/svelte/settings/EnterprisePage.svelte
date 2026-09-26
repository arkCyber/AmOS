<script lang="ts">
  // EnterprisePage.svelte — Settings ▸ 企业功能 (REQ-A584).
  //
  // Why this page exists: three finished enterprise surfaces (`MDMPanel`, `AuditLogViewer`,
  // `APISettings` — 700–1140 lines each, all i18n'd, all backed by the wired `lib/enterprise/*`
  // managers) plus their only list consumer (`components/VirtualList.svelte`) were **unreachable**:
  // `docs/SHORTCUTS_ENTERPRISE_UI_SPEC.md` places them in Settings ▸ 企业功能 (MDM / 模板 / 审计 /
  // API) and that section was never built, so no entry chain reached them and the audit trail
  // (`lib/enterprise/audit.ts`, wired) had **no reading UI at all**. This page is that section.
  //
  // The spec lists **four** tabs, and all four are now mounted. 企业模板 used to be deliberately
  // absent: the page argued that its catalogue "has no producer (`templateManager.syncTemplates` /
  // `initializeEnterprise` are called only from tests)", so the tab would only ever be an empty
  // screen. That reason was a **checkable claim**, and REQ-A1320 falsified it: `TemplateManager`
  // now bootstraps its own three tables lazily from every read and write path
  // (`ensureInitialized()`), exactly as `audit.ts` / `api.ts` / `webhooks.ts` / `mdm.ts` already
  // did — so the local store *is* the producer, and the library shows what the user actually has.
  import MDMPanel from "../modules/MDMPanel.svelte";
  import AuditLogViewer from "../modules/AuditLogViewer.svelte";
  import APISettings from "../modules/APISettings.svelte";
  import TemplateLibrary from "../modules/TemplateLibrary.svelte";
  import { t } from "../locale.svelte";

  type Tab = "mdm" | "templates" | "audit" | "api";
  const TABS: ReadonlyArray<{ id: Tab; key: string }> = [
    { id: "mdm", key: "settings.enterpriseTabMdm" },
    { id: "templates", key: "settings.enterpriseTabTemplates" },
    { id: "audit", key: "settings.enterpriseTabAudit" },
    { id: "api", key: "settings.enterpriseTabApi" },
  ];

  let tab = $state<Tab>("mdm");
</script>

<div class="space-y-4" data-testid="settings-enterprise">
  <div class="flex flex-wrap gap-2" role="tablist" aria-label={t("settings.enterprise")}>
    {#each TABS as item (item.id)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === item.id}
        class="cursor-pointer rounded-full px-3 py-1.5 text-xs font-medium transition active:scale-95 {tab ===
        item.id
          ? 'bg-black/10 dark:bg-white/20'
          : 'bg-black/5 opacity-70 dark:bg-white/10'}"
        onclick={() => (tab = item.id)}
        data-testid={`enterprise-tab-${item.id}`}>{t(item.key)}</button
      >
    {/each}
  </div>

  {#if tab === "mdm"}
    <MDMPanel />
  {:else if tab === "templates"}
    <TemplateLibrary />
  {:else if tab === "audit"}
    <AuditLogViewer />
  {:else}
    <APISettings />
  {/if}
</div>
