<script lang="ts">
  // DiagnosticsPage.svelte — 「系统监控与开发者」sub page. Groups the live
  // sensor / system / task-manager / LMK-debug cards. Each panel renders only when
  // it actually has data (they hide offline), so the page is never a broken card.
  import SensorPanel from "../SensorPanel.svelte";
  import LiveSensors from "../LiveSensors.svelte";
  import SystemPanel from "../SystemPanel.svelte";
  import TaskManager from "../TaskManager.svelte";
  import LmkDebugPanel from "../LmkDebugPanel.svelte";

  // Panels own their headers + data refresh; Sensor/System/TaskManager/Lmk hide
  // themselves when there is nothing to show (daemon offline), so we simply stack.
</script>

<div class="space-y-5">
  <SensorPanel />
  <LiveSensors />
  <SystemPanel />
  <TaskManager />
  <LmkDebugPanel />
</div>
