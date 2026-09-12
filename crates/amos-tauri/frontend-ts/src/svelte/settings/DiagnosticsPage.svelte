<script lang="ts">
  // DiagnosticsPage.svelte — 「系统监控与开发者」sub page. Groups the live
  // sensor / system / task-manager / LMK-debug cards. Each panel renders only when
  // it actually has data (they hide offline), so the page is never a broken card.
  import SensorPanel from "../SensorPanel.svelte";
  import LiveSensors from "../LiveSensors.svelte";
  import SystemPanel from "../SystemPanel.svelte";
  import TaskManager from "../TaskManager.svelte";
  import LmkDebugPanel from "../LmkDebugPanel.svelte";
  import QuarantinePanel from "./QuarantinePanel.svelte";

  // Panels own their headers + data refresh; Sensor/System/TaskManager/Lmk hide
  // themselves when there is nothing to show (daemon offline), so we simply stack.
  // QuarantinePanel is the one panel that needs no daemon: it reports the corrupt
  // store values this shell has preserved locally.
</script>

<div class="space-y-5">
  <QuarantinePanel />
  <SensorPanel />
  <LiveSensors />
  <SystemPanel />
  <TaskManager />
  <LmkDebugPanel />
</div>
