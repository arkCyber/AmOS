<script lang="ts">
  // RobotApp.svelte — 「机器人指挥台 / Robot console」.
  //
  // The System UI's **write** side of AmOS-Link, beside the read-only Settings page
  // (`settings/LinkPage.svelte`). It answers the operator's next question after 「is it on the
  // link?」 — *make it move, and stop it* — without a terminal (the CLI's `pub --socket` was the
  // only way to send a command before this).
  //
  // Two disciplines are load-bearing here and mirrored in the copy:
  //   • **A publish receipt is not proof the command took effect.** The panel shows what the
  //     transport reported (`seq`/`matched`/`delivered`/`dropped`) and says, in words, that the
  //     effect is read back on the return path — `armed`/`estopped`/`gait` below come from the
  //     robot's own reports, never from the receipt. A `delivered=0` is 「the transport could not
  //     count」 (a network transport always answers 0), not 「nobody received it」.
  //   • **E-Stop is never gated.** It is the one command that must go out the instant it is
  //     pressed: no confirmation, no validation, no disabled state beyond a target being chosen.
  //   • **A receipt belongs to the command it names.** Because the safety pair may be sent while a
  //     gait is still in flight, two publishes can overlap; the panel is owned by the most recent
  //     press, so a late answer never appears beneath a label it does not describe.
  //
  // Live data is the daemon's control plane only: `link_status` re-read every 2 s while visible
  // (a snapshot, dated like `LinkPage`), the topic inventory on its own slower cadence, and the
  // heartbeat stream for per-peer liveness. A heartbeat is a claim of liveness *when it was
  // sent*, so each peer's row carries the age of its last beat — otherwise a robot that powered
  // off would keep a row indistinguishable from a live one. The verdict is shown with the
  // daemon's own reasons for it (`health_reasons`): this is the surface an operator *acts* on, so
  // a degraded link has to say why — a lost peer and an uncalibrated clock call for different
  // responses, and the Settings panel already states the reasons. The data plane (sensor frames,
  // joint set points) never travels through gRPC, so this console can command and observe
  // *modes* — it cannot see raw sensor streams.
  import { onMount, onDestroy } from "svelte";
  import { t } from "./locale.svelte";
  import {
    actuationAgeMs,
    counterSummary,
    estopReasonKey,
    formatUptime,
    healthKey,
    linkLevel,
    linkStatus,
    peerDeclared,
    reportAgeKey,
    reportAgeText,
    returnPathKey,
    returnPathLevel,
    robotLevel,
    robotLevelKey,
    robotSummary,
    watchdogText,
    type LinkStatus,
  } from "../lib/link";
  import {
    QUADRUPED_ACTIONS,
    actionJson,
    beatAgeKey,
    beatAgeMs,
    beatOrigin,
    fleetSummary,
    fleetTargets,
    linkTopics,
    listenHeartbeats,
    receiptKey,
    receiptLevel,
    receiptSummary,
    robotCommand,
    robotCommandMany,
    robotTargets,
    startHeartbeats,
    type BeatSeen,
    type FleetReceipt,
    type LinkPublishOut,
    type LinkTopicsOut,
    type QuadrupedActionKey,
  } from "../lib/robot";
  import { GROUP, H2, HINT, LABEL, ROW, SUB, VALUE } from "./settings/kit";

  /** How often the console re-reads the daemon while open and visible. */
  const PROBE_MS = 2_000;
  /** How often the topic inventory is re-read (it changes far less than robot modes). */
  const TOPICS_MS = 10_000;

  let status = $state<LinkStatus | null>(null);
  let loading = $state(false);
  let loaded = $state(false);
  /** When the reading on screen was taken (epoch ms); `0` before the first answer. */
  let readAt = $state(0);

  /** The robot the commands go to (a peer id, typed or picked from the known robots). */
  let target = $state("");
  /** The speed carried by motion gaits. */
  let speed = $state(0.5);

  let sending = $state(false);
  /** The last command actually attempted, so the receipt can name it. */
  let lastSent = $state<{ robot: string; labelKey: string } | null>(null);
  let receipt = $state<LinkPublishOut | null>(null);
  /** True when the last command could not be sent at all (offline / daemon error). */
  let sendFailed = $state(false);
  /**
   * Which press the receipt panel belongs to. The safety pair is deliberately sent even while a
   * gait is still in flight (see `send`), so two sends can overlap; without this token whichever
   * publish *answered last* wrote its numbers under whatever label was pressed last — the gait's
   * transport result shown beneath 「E-Stop」, or a failed gait read as the e-stop not going out.
   * The panel is only ever owned by the most recent press.
   */
  let sendToken = 0;

  /**
   * The last fleet command's outcome, and which press owns that panel — the same reasoning as
   * {@link sendToken}, over a command that takes one round trip *per robot* instead of one, so the
   * window for two fleet presses to overlap is the widest in this component.
   */
  let fleetReceipt = $state<FleetReceipt | null>(null);
  let fleetToken = 0;

  let topics = $state<LinkTopicsOut | null>(null);
  /**
   * The last beat this console heard from each peer, from the daemon's `StreamHeartbeats` —
   * the counter **and when we heard it**, because a heartbeat is a claim of liveness at the
   * moment it was sent: a bare `#seq` cannot tell a beating peer from one that died an hour ago.
   */
  let beats = $state<Record<string, BeatSeen>>({});
  /**
   * Whether this console is being fed a heartbeat stream right now.
   *
   * Three states, because two of them are indistinguishable on a bare 「no beats」 row:
   * `pending` (the subscription has not resolved), `live` (a stream is running, so an empty
   * panel is a real reading of a quiet bus), and `refused` (the host would not start one — then
   * 「no beats」 is a claim about the bus this console is in no position to make). The listen half
   * reports refusal as `null` and the stream half as `false` (REQ-A838/A844); discarding either is
   * what makes the panel lie.
   */
  let beatStream = $state<"pending" | "live" | "refused">("pending");
  /** Guards against two polls retrying at once (each attempt would register its own listener). */
  let beatAttempting = false;
  /**
   * The most recent moment this console observed anything — a status answer or a beat. Ages are
   * measured against it rather than `Date.now()` read in the template, so every age on screen is
   * a real elapsed span and moves with the 2 s re-read instead of freezing at render time.
   */
  let nowMs = $state(0);

  const level = $derived(linkLevel(status));
  const targets = $derived(status ? robotTargets(status) : []);
  // What a *fleet* command addresses: the registry, plus a robot aimed at by hand (see `fleetTargets`).
  const fleet = $derived(fleetTargets(targets, target));
  const robots = $derived(status?.actuations ?? []);
  const safetyActions = $derived(QUADRUPED_ACTIONS.filter((a) => a.safety));
  const gaitActions = $derived(QUADRUPED_ACTIONS.filter((a) => !a.safety));
  const beatPeers = $derived(Object.keys(beats).sort());

  const readStamp = $derived.by(() => {
    if (!readAt) return "";
    const d = new Date(readAt);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  });

  const refresh = async () => {
    loading = true;
    try {
      const next = await linkStatus();
      status = next;
      // The stamp belongs to the *answer*: a failed read has no reading to date, so it resets
      // to 0 and the numbers go with it (a frozen readout would look exactly like a fresh one).
      readAt = next ? Date.now() : 0;
      if (next) nowMs = readAt;
    } finally {
      loading = false;
      loaded = true;
    }
  };

  const refreshTopics = async () => {
    topics = await linkTopics();
  };

  const send = async (key: QuadrupedActionKey) => {
    if (!target) return;
    const action = QUADRUPED_ACTIONS.find((a) => a.key === key);
    // The safety pair is never gated behind an in-flight command: the command it would wait
    // behind may be the very one that needs stopping, and an e-stop must go out the instant
    // it is pressed. A *gait* press is still dropped while one is in flight — a second set
    // point queued behind the first is not worth a send.
    const safety = action?.safety === true;
    if (!safety && sending) return;
    if (!safety) sending = true;
    const token = ++sendToken;
    sendFailed = false;
    receipt = null;
    lastSent = { robot: target, labelKey: action?.labelKey ?? key };
    const r = await robotCommand(target, actionJson(key, speed));
    // A later press may have superseded this one while its publish was in flight; the panel then
    // belongs to *that* press, so an answer that arrives now must not be written beneath the label
    // it no longer describes.
    if (token === sendToken) {
      receipt = r;
      sendFailed = r === null;
    }
    if (!safety) sending = false;
    // Whether it took effect is a *later* read: poll now so the return path catches up.
    void refresh();
  };

  /**
   * E-Stop **every** robot the console knows about.
   *
   * This is the only action offered for the whole fleet, and the asymmetry is the point: leaving a
   * robot out of a stop is a failure, while arming a robot without meaning to is one too — so the
   * stop generalises and arming stays a per-robot press.
   *
   * Never gated, for the same reason the single e-stop is not: it is not held behind an in-flight
   * command, because the command it would wait behind may be the very one that needs stopping. The
   * only precondition is that there is a fleet at all — with no robot to address there is no topic to
   * publish to, and the press would report a stop it never sent.
   *
   * "The fleet" is {@link fleet} — the registry plus a hand-aimed robot — not {@link targets} alone:
   * the console invites an operator to name a robot the registry has not heard from yet, and a stop
   * that skipped the robot on screen while its button read 「全部」 would be the failure this control
   * exists to prevent.
   */
  const sendFleet = async (key: QuadrupedActionKey) => {
    const robots = fleet;
    if (robots.length === 0) return;
    const token = ++fleetToken;
    fleetReceipt = null;
    const r = await robotCommandMany(robots, actionJson(key, speed));
    // A later press owns the panel (see `fleetToken`).
    if (token === fleetToken) fleetReceipt = r;
    // Whether it took effect is a *later* read, per robot, on the return path.
    void refresh();
  };

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let topicsTimer: ReturnType<typeof setInterval> | null = null;
  let stopBeats: (() => void) | null = null;
  let destroyed = false;

  /**
   * Bring the heartbeat channel up — the listener once, the stream on every call.
   *
   * Two lifetimes, so the attempt has two halves:
   *
   * * the **listener** is per window and installed once (its cleanup is kept in `stopBeats`);
   * * the **stream** is process-global and re-asked every time, which is the only thing that ever
   *   restarts a stream that ended under this window. The console cannot see a stream die — the
   *   host ends the task silently when the daemon goes away — so "ask again" is not a retry of a
   *   known failure but the steady state: the host keys its reader accounting by window, so while
   *   the stream is live this shares it (no second stream, no daemon round trip) and after it died
   *   it starts a fresh one.
   *
   * Nothing here leaks under repetition: the listener is not re-registered, the stream half has no
   * cleanup of its own (the window's one close releases the claim), and the host gives this
   * window's claim back when a start fails "so the next window tries again instead of attaching to
   * a stream that does not exist". Without the re-ask, a daemon that went away while the console
   * was open stayed unreadable for the life of the window, while the 2 s status poll showed it back.
   */
  const openBeats = async () => {
    if (beatAttempting) return;
    beatAttempting = true;
    try {
      if (stopBeats === null) {
        const un = await listenHeartbeats((b) => {
          const at = Date.now();
          nowMs = at;
          beats = { ...beats, [b.peer]: { seq: b.seq, at } };
        });
        // REQ-A838: `null` = the listen (or the bridge) was refused. No listener, so the stream is
        // deliberately **not** asked for either — there is nothing to tear down, and the beat panel
        // must not present a frozen "last seen" as a link that went quiet.
        if (un === null) {
          beatStream = "refused";
          return;
        }
        // The subscription resolves asynchronously; if the console was already closed, tear it down
        // now instead of storing a cleanup nobody will call.
        if (destroyed) {
          un();
          return;
        }
        stopBeats = un;
      }
      beatStream = (await startHeartbeats()) ? "live" : "refused";
    } finally {
      beatAttempting = false;
    }
  };

  onMount(() => {
    void refresh();
    void refreshTopics();
    void openBeats();
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh();
        // The stream is re-asked on the same cadence as the read it accompanies — a refused one, a
        // live one (which shares it for free), and above all one that ended under this window.
        void openBeats();
      }
    }, PROBE_MS);
    topicsTimer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshTopics();
    }, TOPICS_MS);
  });

  onDestroy(() => {
    destroyed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (topicsTimer) clearInterval(topicsTimer);
    stopBeats?.();
  });

  // When the fleet first becomes known and no target has been chosen, default to the first robot
  // so a single press works.
  //
  // The fill happens **once**, on the first read that names any robot — the condition this comment
  // always claimed, and which the code did not carry. `targets` is `$derived` over `status`, so it
  // is a *new array on every 2 s poll*; a bare `if (!target …)` guard therefore re-ran forever and
  // refilled a field the operator had just cleared. That left the console unable to reach
  // 「no target」 at all: every backspace was undone within one poll, the single E-Stop stayed aimed
  // at whichever robot sorts first, and `robot.targetNone`'s advice (「可以手动填一个 id」) described
  // a state the picker would not hold. The latch is set only when the fleet actually becomes known,
  // so a fleet that is empty at open — or a daemon not yet up — is still defaulted when it appears.
  // A target the operator typed *or cleared* is never overwritten.
  let filled = false;
  $effect(() => {
    if (filled || targets.length === 0) return;
    filled = true;
    if (!target) target = targets[0] ?? "";
  });
</script>

<div class="h-full overflow-y-auto px-3 py-4" data-testid="robot-app">
  <div class="space-y-5">
    <section class={GROUP}>
      <div class={ROW}>
        <span class={LABEL}>🦿 {t("app.robot")}</span>
        <button
          class="text-[15px] text-accent active:scale-95 disabled:opacity-40"
          onclick={() => {
            void refresh();
            void refreshTopics();
          }}
          disabled={loading}
          aria-label={t("link.refresh")}
        >
          {t("link.refresh")}
        </button>
      </div>
      <div class={SUB}></div>
      <div class="px-4 py-3">
        <p class={VALUE} data-testid="robot-verdict">{t(healthKey(level))}</p>
        {#if status}
          <p class="mt-1 text-xs opacity-60">
            {status.peer} · {status.kind} · v{status.version}
          </p>
          <p class="mt-1 text-xs opacity-60">
            {t("link.uptime")}: {formatUptime(status.uptime_ms)} ·
            {status.clock_synced ? t("link.clockSynced") : t("link.clockUnsynced")}
          </p>
        {/if}
        {#if readStamp}
          <p class={HINT} data-testid="robot-read-at">{t("robot.probe", { time: readStamp })}</p>
        {/if}
      </div>
    </section>

    <!-- Why the verdict is what it is. The daemon's own reason tokens travel with the fold
         (`link_status.health_reasons`) and the Settings panel states them (`link.reasonsHeading`);
         the console discarded them, so the surface where an operator *acts* on the link showed a
         bare 「链路降级」 — no way to tell a lost peer from an uncalibrated clock, which is exactly
         the distinction that decides whether commanding is safe. The tokens are the daemon's
         vocabulary (rendered verbatim, as the CLI does); unknown reason tokens are not invented. -->
    {#if status && status.health_reasons.length > 0}
      <section class={GROUP}>
        <div class="px-4 py-3">
          <p class={H2}>{t("link.reasonsHeading")}</p>
          <ul class="mt-1.5 space-y-1 text-sm opacity-80" data-testid="robot-reasons">
            {#each status.health_reasons as reason (reason)}
              <li class="truncate">{reason}</li>
            {/each}
          </ul>
        </div>
      </section>
    {/if}

    <!-- Target selection: a free-text id with the known robots offered as completions, so a
         robot that has not reported yet (only a beacon) can still be commanded by name. -->
    <section class={GROUP}>
      <div class="px-4 py-3">
        <p class={H2}>{t("robot.targetHeading")}</p>
        <input
          class="mt-2 w-full rounded-ios-input bg-black/5 px-3.5 py-2.5 text-ios-body outline-none dark:bg-white/10"
          list="robot-targets"
          bind:value={target}
          placeholder={t("robot.targetPlaceholder")}
          aria-label={t("robot.targetHeading")}
          data-testid="robot-target"
        />
        <datalist id="robot-targets">
          {#each targets as id (id)}
            <option value={id}></option>
          {/each}
        </datalist>
        <!-- `targets` is derived from `status`, so an unanswered read makes it empty — and an
             empty list has two very different causes. Only the daemon's own answer can say 「there
             is no known robot」 (and only then is 「type an id, or wait for a peer to announce
             itself」 true advice, since an announcement is something this console only hears by
             reading the table). With no answer, the honest thing is to say exactly that — the
             sibling sections keep the same two facts apart (`topicsUnavailable`,
             `heartbeatsUnavailable`, `returnPathKey("unavailable")`), and `loaded` gates the claim
             so it cannot flash before the first read has landed. -->
        {#if status && targets.length === 0}
          <p class={HINT} data-testid="robot-target-none">{t("robot.targetNone")}</p>
        {:else if !status && loaded}
          <p class={HINT} data-testid="robot-target-unavailable">
            {t("robot.targetUnavailable")}
          </p>
        {/if}
      </div>
    </section>

    <!-- Command palette. E-Stop leads and is never disabled by validation. -->
    <section class={GROUP}>
      <div class="px-4 py-3">
        <p class={H2}>{t("robot.commandHeading")}</p>
        <div class="mt-2 grid grid-cols-2 gap-2">
          {#each safetyActions as action (action.key)}
            <button
              class={action.key === "estop"
                ? "rounded-ios-input bg-red-600 px-3 py-3 text-ios-body font-semibold text-white active:scale-95 disabled:opacity-40"
                : "rounded-ios-input bg-black/[0.06] px-3 py-3 text-ios-body active:scale-95 disabled:opacity-40 dark:bg-white/10"}
              onclick={() => void send(action.key)}
              disabled={!target}
              data-testid={`robot-cmd-${action.key}`}
            >
              {t(action.labelKey)}
            </button>
          {/each}
        </div>

        <!-- Fleet stop. The pair above is aimed at the chosen robot; this one is aimed at every
             robot the console can address — the registry **and** the robot in the target box — and is
             the one command that must not require picking a target first: an e-stop that needs a
             robot selected is an e-stop that arrives late, and the fleet is exactly what an operator
             reaches for when the screen is confusing. It is never held behind an in-flight command
             either (see `sendFleet`). -->
        <button
          class="mt-3 w-full rounded-ios-input bg-red-600 px-3 py-3 text-ios-body font-semibold text-white active:scale-95 disabled:opacity-40"
          onclick={() => void sendFleet("estop")}
          disabled={fleet.length === 0}
          data-testid="robot-cmd-estop-all"
        >
          {t("robot.actionEstopAll", { n: fleet.length })}
        </button>

        <div class="mt-3 grid grid-cols-4 gap-2">
          {#each gaitActions as action (action.key)}
            <button
              class="rounded-ios-input bg-black/[0.06] px-2 py-2.5 text-ios-body active:scale-95 disabled:opacity-40 dark:bg-white/10"
              onclick={() => void send(action.key)}
              disabled={!target || sending}
              data-testid={`robot-cmd-${action.key}`}
            >
              {t(action.labelKey)}
            </button>
          {/each}
        </div>

        <label class="mt-3 block">
          <span class="text-xs opacity-70">{t("robot.speed")}: {speed.toFixed(2)}</span>
          <input
            class="mt-1 w-full"
            type="range"
            min="0"
            max="1"
            step="0.05"
            bind:value={speed}
            aria-label={t("robot.speed")}
            data-testid="robot-speed"
          />
        </label>
      </div>
    </section>

    <!-- The receipt: what the transport reported, and the honest caveat that it is not the
         effect. -->
    {#if lastSent}
      <section class={GROUP}>
        <div class="px-4 py-3">
          <p class={H2}>{t("robot.receiptHeading")}</p>
          <p class="mt-1.5 text-sm opacity-80" data-testid="robot-receipt-action">
            {t(lastSent.labelKey)} → {lastSent.robot}
          </p>
          {#if sendFailed}
            <p class="mt-1 text-sm opacity-80 text-red-600" data-testid="robot-receipt-failed">
              {t("robot.receiptFailed")}
            </p>
          {:else if receipt}
            <p class="mt-1 text-xs opacity-70 font-mono" data-testid="robot-receipt">
              {receiptSummary(receipt)}
            </p>
            <p class="mt-1 text-xs opacity-60" data-testid="robot-receipt-note">
              {t(receiptKey(receiptLevel(receipt)))}
            </p>
          {/if}
          <p class="mt-2 text-xs opacity-60">{t("robot.receiptBoundary")}</p>
        </div>
      </section>
    {/if}

    <!-- The fleet receipt, kept apart from the single-robot one above on purpose: a fleet press
         produces N answers that need not agree, so it has no `seq`/`matched`/`delivered` to show.
         What it has is the list of robots a stop did **not** reach, which is the only actionable
         half — a stop that reached three robots still says nothing about whether they stopped,
         and that caveat is the same one the single receipt carries. -->
    {#if fleetReceipt}
      <section class={GROUP}>
        <div class="px-4 py-3">
          <p class={H2}>{t("robot.fleetHeading")}</p>
          <p class="mt-1.5 text-sm opacity-80 font-mono" data-testid="robot-fleet-receipt">
            {fleetSummary(fleetReceipt)}
          </p>
          {#if fleetReceipt.sent.length > 0}
            <p class="mt-2 text-xs opacity-70" data-testid="robot-fleet-sent">
              {t("robot.fleetSent")}: {fleetReceipt.sent.join(", ")}
            </p>
          {/if}
          {#if fleetReceipt.failed.length > 0}
            <p class="mt-1 text-xs text-red-600" data-testid="robot-fleet-failed">
              {t("robot.fleetFailed")}: {fleetReceipt.failed.join(", ")}
            </p>
          {/if}
          <p class="mt-2 text-xs opacity-60">{t("robot.receiptBoundary")}</p>
        </div>
      </section>
    {/if}

    <!-- Return path: what each robot says about itself. `armed`/`estopped` here are the effect
         the receipt could not prove. -->
    <section class={GROUP}>
      <div class="px-4 py-3">
        <p class={H2}>{t("link.robotsHeading")}</p>
        {#if status && returnPathLevel(status) === "unavailable"}
          <p class="mt-1.5 text-sm opacity-70" data-testid="robot-robots-unavailable">
            {t(returnPathKey("unavailable"))}
          </p>
        {:else if robots.length > 0}
          <ul class="mt-1.5 space-y-2" data-testid="robot-robots">
            {#each robots as robot (robot.robot)}
              {@const ageMs = actuationAgeMs(robot, readAt)}
              {@const reasonKey = estopReasonKey(robot.estop_reason)}
              <li class="text-sm">
                <div class="flex justify-between gap-3">
                  <span class="truncate">{robotSummary(robot)}</span>
                  <span class="shrink-0 opacity-70">
                    {t(robotLevelKey(robotLevel(robot)))}
                  </span>
                </div>
                <p class="text-xs opacity-60" data-testid="robot-age">
                  {t(reportAgeKey(ageMs), { age: reportAgeText(ageMs ?? 0) })}
                </p>
                <!-- How much of the last action reached the bus — the count the HAL **measured**
                     (`RobotHal::apply`/`estop` return how many frames the bus accepted, never a
                     guess: see `docs/amos-link.md` §3). It is the one fact that separates
                     「commanded」 from 「wrote nothing to the bus」, and for a profile machine it is
                     the *only* such fact — those report `gait` empty by design
                     (`docs/robot-domains.md` §6.4). -->
                <p class="text-xs opacity-60" data-testid="robot-frames">
                  {t("link.actuationFrames")}: {robot.frames}
                </p>
                <!-- Why torque was cut, and the deadman period it runs under: `estopped` alone
                     cannot tell a watchdog cut from a commanded one (the CLI prints the same
                     fact as `estopped=true(watchdog)`). -->
                {#if reasonKey}
                  <p class="text-xs opacity-60" data-testid="robot-estop-reason">
                    {t("link.estopReason")}: {t(reasonKey)}
                  </p>
                {/if}
                {#if robot.watchdog_ms !== null}
                  <p class="text-xs opacity-60" data-testid="robot-watchdog">
                    {t("link.watchdogPeriod")}: {watchdogText(robot.watchdog_ms)}
                  </p>
                {/if}
                {#if robot.last_refusal}
                  <p class="text-xs opacity-60" data-testid="robot-refusal">
                    {t("link.robotRefused", { seq: robot.last_refusal.seq })}:
                    {robot.last_refusal.reason}
                  </p>
                {/if}
              </li>
            {/each}
          </ul>
        {:else if status}
          <p class="mt-1.5 text-sm opacity-70" data-testid="robot-robots-none">
            {t("link.noReports")}
          </p>
        {/if}
      </div>
    </section>

    <!-- Diagnostics -->
    {#if status}
      <section class={GROUP}>
        <div class="px-4 py-3">
          <p class={H2}>{t("robot.heartbeatsHeading")}</p>
          {#if beatStream === "refused"}
            <!-- No stream right now: the host refused the subscription, or the daemon is gone and
                 it would not start a fresh one — so 「nothing is beating」 would be a claim about a
                 bus this console is not listening to. Said **before** the rows and not instead of
                 them: rows heard while a stream *was* up are still true statements about when each
                 peer was last heard, but an age alone cannot tell 「the robot went silent」 from
                 「we stopped listening」, which is the one answer this panel exists to give. The
                 topic inventory below keeps its two states apart the same way. -->
            <p class="mt-1.5 text-sm opacity-70" data-testid="robot-heartbeats-unavailable">
              {t("robot.heartbeatsUnavailable")}
            </p>
          {:else if beatStream === "pending"}
            <!-- The third state, and the one this panel used to collapse into 「quiet」: the
                 subscription has not resolved, so this console has not yet established *whether* it
                 is listening. `beatStream`'s own declaration says the three states exist because two
                 of them are indistinguishable on a bare 「no beats」 row — this is that row being
                 made distinguishable. Transient on a healthy host (the status read can land first);
                 permanent on a host that never answers the subscription, which is exactly when
                 「还没有收到心跳。」 would have been a quiet-bus claim about a channel this console
                 does not have. -->
            <p class="mt-1.5 text-sm opacity-70" data-testid="robot-heartbeats-pending">
              {t("robot.heartbeatsStarting")}
            </p>
          {/if}
          {#if beatPeers.length > 0}
            <ul class="mt-1.5 space-y-2 text-xs opacity-70" data-testid="robot-heartbeats">
              {#each beatPeers as p (p)}
                <!--
                  A peer's row is what makes 「is it alive」 answerable: the counter says how far
                  along it is, and the age says whether the answer is *current* — a robot that
                  stopped beating keeps a row, but a dated one reads as silent instead of live.
                -->
                {@const ageMs = beatAgeMs(beats[p], nowMs)}
                {@const origin = beatOrigin(p, status)}
                <!-- `data-origin` is the row's own answer to 「what is this?」, so the three
                     answers (`self` / `peer` / `unknown`) are separable by a test and by a reader
                     of the DOM — a beat names only its sender, and the join that names the *what*
                     is the whole point of this row (see `beatOrigin`). -->
                <li data-origin={origin.role}>
                  <div class="flex justify-between gap-3">
                    <span class="truncate">
                      {p} · {origin.role === "peer"
                        ? origin.token
                        : t(origin.role === "self" ? "robot.beatSelf" : "robot.beatPeerUnknown")}
                    </span>
                    <span class="shrink-0">#{beats[p]?.seq ?? 0}</span>
                  </div>
                  <p class="opacity-60" data-testid="robot-beat-age">
                    {t(beatAgeKey(ageMs), { age: reportAgeText(ageMs ?? 0) })}
                  </p>
                </li>
              {/each}
            </ul>
          {:else if beatStream === "live"}
            <!-- A stream is *running* and nothing has come over it — the only case in which this
                 sentence is a reading of the bus rather than a claim about a channel this console
                 does not have. The condition has to be exactly `live`: `pending` has not
                 established that a channel exists at all (the notice above now says so), and
                 `refused` never had one. -->
            <p class="mt-1.5 text-sm opacity-70" data-testid="robot-heartbeats-none">
              {t("robot.heartbeatsNone")}
            </p>
          {/if}
        </div>
      </section>

      <section class={GROUP}>
        <div class="px-4 py-3">
          <p class={H2}>{t("link.peersHeading")}</p>
          {#if status.peers.length > 0}
            <!--
              This table is the surface the target picker above is built from, so it carries the
              three facts the bridge spends effort producing per peer (`link.rs::peer_out` maps an
              absent endpoint to `null` and an unknown kind to a token). Dropping them — rendering
              `id (kind)` — leaves an operator unable to tell a live robot from one **declared by
              hand** (`beacons === 0`, static and never TTL-expired) or one that went silent long
              ago (`last_seen_ms` is an age, per `proto/robot_link.proto`). A peer's row is where
              「can I command this?」 is answerable, so it says how long ago it was last evidenced
              — and, when there is no evidence at all, that it was configured rather than heard.
            -->
            <ul class="mt-1.5 space-y-1 text-sm opacity-80" data-testid="robot-peers">
              {#each status.peers as peer (peer.id)}
                <li class="flex justify-between gap-3">
                  <span class="truncate">
                    {peer.id} · {peer.kind}{#if peer.endpoint} · {peer.endpoint}{/if}
                  </span>
                  <span class="shrink-0 opacity-70" data-testid="robot-peer-seen">
                    {peerDeclared(peer) ? t("link.peerDeclared") : reportAgeText(peer.last_seen_ms)}
                  </span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="mt-1.5 text-sm opacity-70">{t("link.noPeers")}</p>
          {/if}
        </div>
      </section>

      <section class={GROUP}>
        <div class="px-4 py-3">
          <p class={H2}>{t("robot.topicsHeading")}</p>
          {#if topics}
            <p class="mt-1 text-xs opacity-60" data-testid="robot-topics-complete">
              {topics.complete ? t("robot.topicsComplete") : t("robot.topicsPartial")}
            </p>
            {#if topics.topics.length > 0}
              <ul class="mt-1.5 space-y-1 text-xs opacity-70 font-mono" data-testid="robot-topics">
                {#each topics.topics as topic (topic)}
                  <li class="truncate">{topic}</li>
                {/each}
              </ul>
            {:else if topics.complete}
              <!-- An empty list is evidence of an empty bus **only when the transport says the
                   list is the whole truth** (`TopicList.complete`). An empty *incomplete* list is
                   the opposite fact: the transport stating it cannot enumerate (a network
                   transport always answers empty + incomplete — `Transport::topics_complete`),
                   so claiming 「no publishes」 here would contradict the caveat line above it. -->
              <p class="mt-1.5 text-sm opacity-70" data-testid="robot-topics-none">
                {t("robot.topicsNone")}
              </p>
            {/if}
          {:else}
            <p class="mt-1.5 text-sm opacity-70" data-testid="robot-topics-unavailable">
              {t("robot.topicsUnavailable")}
            </p>
          {/if}
        </div>
      </section>

      <section class={GROUP}>
        <div class="px-4 py-3">
          <p class={H2}>{t("link.countersHeading")}</p>
          <p class="mt-1.5 text-sm opacity-80" data-testid="robot-counters">
            {counterSummary(status.metrics)}
          </p>
        </div>
      </section>
    {/if}

    {#if !status && loaded}
      <p class={HINT}>{t("robot.tip")}</p>
    {/if}

    <p class={HINT}>{t("robot.boundary")}</p>
  </div>
</div>
