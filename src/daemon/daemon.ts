import fs from "node:fs";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { AckDispatcher, AckWorker } from "../agent/ack-dispatcher.js";
import { ClaudeProxyCoordinator, ClaudeProxyWorker } from "../agent/claude-proxy.js";
import { ClaudeProxyStore } from "../agent/claude-proxy-store.js";
import { CompletionWorker } from "../agent/completion-worker.js";
import { AgentCoordinator, AgentDispatchWorker } from "../agent/coordinator.js";
import { DispatcherControlCoordinator } from "../agent/dispatcher-control.js";
import {
  createGithubReviewArtifactLookup,
  createGithubReviewStatusEnsure,
  createGithubReviewStatusLookup,
} from "../agent/github-review-status.js";
import { createGithubReviewCommitLookup } from "../agent/github-review-head.js";
import { defaultHermesSessionLookup } from "../agent/hermes-session-reuse.js";
import {
  LinearGraphqlDirectory,
  type LinearIssueDirectory,
  UnconfiguredLinearDirectory,
} from "../agent/linear-directory.js";
import { createLiveSourceReplyResponders } from "../agent/live-reply-responders.js";
import { createLiveAckResponders } from "../agent/live-responders.js";
import { ParentReportFence } from "../agent/parent-report-fence.js";
import { SourceReplyDispatcher, SourceReplyWorker } from "../agent/reply-dispatcher.js";
import { PlaceholderLocalSafetyScreener } from "../agent/safety.js";
import {
  ScheduledChannelDeliveryService,
  ScheduledChannelDeliveryStore,
} from "../agent/scheduled-channel-delivery.js";
import { ScheduledFollowupService, ScheduledFollowupStore } from "../agent/scheduled-followup.js";
import { AgentRequestStore, WorkItemStore } from "../agent/store.js";
import { ThreadTitleWorker, upgradeLegacyTaskTitles } from "../agent/title-sync-worker.js";
import { loadConfig, loadDispatcherDefaultAgent } from "../config.js";
import { DeliveryQueue } from "../core/queue.js";
import { matchRoutes } from "../core/router.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import type { Logger } from "../logging.js";
import { ensurePrivateWakewireHome, stateFilePath } from "../paths.js";
import { PeopleStore } from "../people/store.js";
import { createSecretStore } from "../secrets/store.js";
import { ClaudeCliAdapter } from "../sinks/claude-cli.js";
import { ClaudeRcTmuxAdapter } from "../sinks/claude-rc-tmux.js";
import { createAdapter } from "../sinks/factory.js";
import { prepareWorktree } from "../sinks/worktree.js";
import {
  type LinearEnvironmentIdentity,
  resolveLinearEnvironmentIdentity,
} from "../sources/linear/environment.js";
import { LinearAgentTokenProvider } from "../sources/linear/token.js";
import { VERSION } from "../version.js";
import { createApi } from "./api.js";
import { SourceManager } from "./sources.js";

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  version: string;
}

export class Daemon {
  private queue: DeliveryQueue | null = null;
  private sources: SourceManager | null = null;
  private server: Server | null = null;
  private adapter: import("../sinks/types.js").AgentAdapter | null = null;
  private claudeAdapters: import("../sinks/types.js").AgentAdapter[] = [];
  private db: ReturnType<typeof openDatabase> | null = null;
  private ackWorker: AckWorker | null = null;
  private completionWorker: CompletionWorker | null = null;
  private sourceReplyWorker: SourceReplyWorker | null = null;
  private agentWorker: AgentDispatchWorker | null = null;
  private claudeWorker: ClaudeProxyWorker | null = null;
  private titleWorker: ThreadTitleWorker | null = null;

  constructor(private readonly logger: Logger) {}

  async start(): Promise<DaemonState> {
    ensurePrivateWakewireHome();
    this.db = openDatabase();
    const stores = createStores(this.db);
    const config = loadConfig(stores.settings);
    const secrets = await createSecretStore(this.logger);
    const linearEnvironment = await resolveLinearEnvironmentIdentity();
    if (linearEnvironment) {
      this.logger.info(
        {
          linearUserId: linearEnvironment.id,
          linearUser: linearEnvironment.name,
          linearOrganizationId: linearEnvironment.organizationId,
        },
        "validated dedicated Linear environment credential",
      );
    }
    const adapter = createAdapter(config, this.logger);
    this.adapter = adapter;

    const people = new PeopleStore(this.db);
    const workItems = new WorkItemStore(this.db);
    const upgradedTitles = upgradeLegacyTaskTitles(workItems);
    if (upgradedTitles > 0) {
      this.logger.info({ upgradedTitles }, "upgraded legacy WakeWire task titles");
    }
    const agentRequests = new AgentRequestStore(this.db);
    const coordinator = new AgentCoordinator(people, workItems, agentRequests, undefined, {
      sinkAdapterName: adapter.name,
    });
    const claudeProxy = new ClaudeProxyStore(this.db);
    const claudeCoordinator = new ClaudeProxyCoordinator(
      this.db,
      people,
      workItems,
      agentRequests,
      claudeProxy,
      undefined,
      { defaultAgent: () => loadDispatcherDefaultAgent(stores.settings) },
    );
    const dispatcherControl = new DispatcherControlCoordinator(
      this.db,
      people,
      agentRequests,
      stores.settings,
      coordinator,
    );
    const claudePrintAdapter = new ClaudeCliAdapter(this.logger, {
      claudePath: config.claudePath,
    });
    const claudeRcAdapter = new ClaudeRcTmuxAdapter(this.logger, {
      claudePath: config.claudePath,
      tmuxPath: config.tmuxPath,
    });
    this.claudeAdapters = [claudePrintAdapter, claudeRcAdapter];
    const safetyScreener = new PlaceholderLocalSafetyScreener();
    this.logger.warn(
      {
        safetyPolicyVersion: safetyScreener.policyVersion,
        safetyScreenMode: safetyScreener.mode,
        safetyScreenEnforcing: safetyScreener.enforcing,
      },
      "local safety model is not configured; placeholder screening allows dispatch",
    );
    const ackWorker = new AckWorker(
      agentRequests,
      new AckDispatcher(
        createLiveAckResponders({
          secrets,
          sources: stores.sources,
          linearEnvironment,
        }),
      ),
    );
    this.ackWorker = ackWorker;
    const sourceReplyWorker = new SourceReplyWorker(
      agentRequests,
      new SourceReplyDispatcher(
        createLiveSourceReplyResponders({
          secrets,
          sources: stores.sources,
          linearEnvironment,
        }),
      ),
    );
    this.sourceReplyWorker = sourceReplyWorker;
    const scheduledFollowups = new ScheduledFollowupService(
      new ScheduledFollowupStore(this.db),
      agentRequests,
      people,
      () => sourceReplyWorker.wake(),
    );
    const scheduledChannelDeliveries = new ScheduledChannelDeliveryService(
      new ScheduledChannelDeliveryStore(this.db),
      agentRequests,
      people,
      () => sourceReplyWorker.wake(),
    );
    const titleWorker = new ThreadTitleWorker(workItems, adapter, this.logger);
    this.titleWorker = titleWorker;
    const parentReportFence = new ParentReportFence();
    const completionWorker = CompletionWorker.live(
      agentRequests,
      this.logger,
      () => sourceReplyWorker.wake(),
      {
        adapter,
        parentReportFence,
        onTerminal: (request) => {
          if (request.codexThreadId)
            titleWorker.reassert(request.workItemId, request.codexThreadId);
        },
      },
    );
    this.completionWorker = completionWorker;
    const agentWorker = new AgentDispatchWorker(
      people,
      workItems,
      agentRequests,
      dynamicLinearDirectory(stores.sources, secrets, globalThis.fetch, linearEnvironment),
      adapter,
      this.logger,
      {
        safetyScreener,
        parentReportFence,
        onReplyQueued: () => sourceReplyWorker.wake(),
        hermesSessionLookup: defaultHermesSessionLookup,
        reviewStatusLookup: createGithubReviewStatusLookup({ secrets }),
        reviewStatusEnsure: createGithubReviewStatusEnsure({ secrets }),
        reviewArtifactLookup: createGithubReviewArtifactLookup({ secrets }),
        reviewCommitLookup: createGithubReviewCommitLookup({ secrets }),
      },
    );
    this.agentWorker = agentWorker;
    const claudeWorker = new ClaudeProxyWorker(
      this.db,
      people,
      workItems,
      agentRequests,
      claudeProxy,
      { print: claudePrintAdapter, "rc-tmux": claudeRcAdapter },
      this.logger,
      {
        safetyScreener,
        onReplyQueued: () => sourceReplyWorker.wake(),
      },
    );
    this.claudeWorker = claudeWorker;

    const queue = new DeliveryQueue(stores, adapter, this.logger, {
      ratePerMinute: config.ratePerMinute,
      prepareWorktree: (_route, delivery) =>
        prepareWorktree((_route.target as { cwd: string }).cwd, delivery.id),
    });
    this.queue = queue;

    const sources = new SourceManager(stores, secrets, this.logger, (event) => {
      const control = dispatcherControl.accept(event);
      if (control.claimed) {
        if (control.accepted) {
          setImmediate(() => {
            ackWorker.wake();
            if (control.replyQueued) sourceReplyWorker.wake();
          });
          this.logger.info(
            {
              request: control.requestId,
              source: event.source,
              duplicate: control.duplicate,
              dispatcherDefaultAgent: control.defaultAgent,
            },
            "accepted authenticated dispatcher default control",
          );
        } else {
          this.logger.warn(
            { source: event.source, deliveryId: event.deliveryId, reason: control.reason },
            "ignored unauthorized dispatcher default control",
          );
        }
        return;
      }
      const claude = claudeCoordinator.accept(event);
      if (claude.claimed) {
        if (claude.accepted) {
          setImmediate(() => {
            ackWorker.wake();
            claudeWorker.wake();
            if (claude.replyQueued) sourceReplyWorker.wake();
          });
          this.logger.info(
            {
              request: claude.requestId,
              session: claude.sessionId,
              source: event.source,
              duplicate: claude.duplicate,
            },
            "accepted authenticated Claude proxy turn",
          );
        } else {
          this.logger.warn(
            {
              source: event.source,
              deliveryId: event.deliveryId,
              session: claude.sessionId,
              reason: claude.reason,
            },
            "ignored unauthorized or held Claude proxy turn",
          );
        }
        return;
      }
      const agent = claude.codexOverride
        ? coordinator.acceptSlackDispatcherOverride(event)
        : coordinator.accept(event);
      if (agent.addressed) {
        if (agent.accepted) {
          // Let the provider's transport-level ack complete first. The visible
          // reaction is already durable but cannot become due for ten seconds.
          setImmediate(() => {
            ackWorker.wake();
            agentWorker.wake();
          });
          this.logger.info(
            { request: agent.requestId, source: event.source, duplicate: agent.duplicate },
            "accepted authenticated Chip request",
          );
        } else {
          // Fail closed and stay silent on the provider to avoid becoming an
          // account-discovery oracle for unregistered senders.
          this.logger.warn(
            { source: event.source, deliveryId: event.deliveryId, reason: agent.reason },
            "ignored unauthorized Chip request",
          );
        }
        return;
      }
      const routes = matchRoutes(stores.routes.listEnabled(), event);
      if (routes.length === 0) {
        this.logger.debug(
          { source: event.source, kind: event.kind, deliveryId: event.deliveryId },
          "event matched no routes",
        );
        return;
      }
      for (const route of routes) {
        queue.enqueueEvent(route, event);
      }
    });
    this.sources = sources;

    const startedAt = new Date().toISOString();
    const api = createApi({
      stores,
      queue,
      sources,
      secrets,
      adapter,
      config,
      logger: this.logger,
      startedAt,
      scheduledChannelDeliveries,
      scheduledFollowups,
      linearEnvironment,
      safetyScreening: {
        policyVersion: safetyScreener.policyVersion,
        mode: safetyScreener.mode,
        enforcing: safetyScreener.enforcing,
      },
    });

    const port = await new Promise<number>((resolve) => {
      const server = serve(
        { fetch: api.fetch, hostname: "127.0.0.1", port: config.apiPort },
        (info) => resolve(info.port),
      );
      this.server = server as Server;
    });

    const state: DaemonState = {
      pid: process.pid,
      port,
      token: config.apiToken,
      startedAt,
      version: VERSION,
    };
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.chmodSync(stateFilePath(), 0o600);

    queue.start();
    ackWorker.start();
    sourceReplyWorker.start();
    titleWorker.start();
    completionWorker.start();
    const claudeRecovery = claudeWorker.start();
    if (
      claudeRecovery.sessionsHeld > 0 ||
      claudeRecovery.turnsHeld.length > 0 ||
      claudeRecovery.submittedTurns.length > 0
    ) {
      this.logger.warn(
        {
          sessionsHeld: claudeRecovery.sessionsHeld,
          turnsHeld: claudeRecovery.turnsHeld.length,
          submittedTurns: claudeRecovery.submittedTurns.length,
        },
        "Claude proxy recovery requires operator inspection; no turn was replayed",
      );
    }
    if (claudeRecovery.turnsReleased.length > 0) {
      this.logger.info(
        { turnsReleased: claudeRecovery.turnsReleased.length },
        "safely released host-only Claude proxy close controls after restart",
      );
    }
    agentWorker.start();
    await sources.startAll();

    this.logger.info(
      {
        port,
        adapter: adapter.name,
        dispatcherDefaultAgent: config.dispatcherDefaultAgent,
        version: VERSION,
      },
      "wakewire daemon ready on 127.0.0.1",
    );
    return state;
  }

  async stop(): Promise<void> {
    this.logger.info("daemon shutting down");
    await drainDaemonRuntime({
      sources: this.sources,
      server: this.server,
      workers: [
        this.queue,
        this.ackWorker,
        this.completionWorker,
        this.sourceReplyWorker,
        this.titleWorker,
        this.claudeWorker,
        this.agentWorker,
      ],
      adapter: this.adapter,
      additionalAdapters: this.claudeAdapters,
      database: this.db,
    });
    try {
      const state = JSON.parse(fs.readFileSync(stateFilePath(), "utf8")) as DaemonState;
      if (state.pid === process.pid) fs.unlinkSync(stateFilePath());
    } catch {
      // state file already gone
    }
  }
}

interface DaemonRuntimeShutdown {
  sources: { stopAll(): Promise<void> } | null;
  server: { close(callback: () => void): unknown } | null;
  workers: Array<{ stop(): Promise<void> } | null>;
  adapter: { close?(): void } | null;
  additionalAdapters?: Array<{ close?(): void }>;
  database: { close(): void } | null;
}

/** Stop ingress, then drain every worker, then release shared runtime resources. */
export async function drainDaemonRuntime(runtime: DaemonRuntimeShutdown): Promise<void> {
  await Promise.all([runtime.sources?.stopAll(), closeServer(runtime.server)]);
  await Promise.allSettled(runtime.workers.map((worker) => worker?.stop()));
  // Kills adapter connections AND any shared app-server child it owns —
  // otherwise the hard exit below orphans the spawned server.
  try {
    runtime.adapter?.close?.();
    for (const adapter of runtime.additionalAdapters ?? []) adapter.close?.();
  } finally {
    runtime.database?.close();
  }
}

function closeServer(server: DaemonRuntimeShutdown["server"]): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

export function dynamicLinearDirectory(
  sources: import("../db/repos.js").SourceStore,
  secrets: import("../secrets/store.js").SecretStore,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  linearEnvironment: LinearEnvironmentIdentity | null = null,
): LinearIssueDirectory {
  const directories = new Map<string, LinearGraphqlDirectory>();
  const environmentDirectory = linearEnvironment
    ? new LinearGraphqlDirectory({
        token: linearEnvironment.apiKey,
        authKind: "api-key",
        fetch: fetchImpl,
      })
    : null;
  const current = (): LinearIssueDirectory => {
    if (environmentDirectory) return environmentDirectory;
    // Sources and credentials can be added while the daemon is already
    // running. Resolve them at query time so `auth linear-agent` takes effect
    // without leaving the dispatch worker pinned to its startup snapshot.
    const source = sources
      .findByKind("webhook")
      .find((record) => String(record.config.name).toLowerCase() === "linear");
    if (!source) return new UnconfiguredLinearDirectory();

    let directory = directories.get(source.id);
    if (!directory) {
      const provider = new LinearAgentTokenProvider(source.id, secrets, { fetch: fetchImpl });
      directory = new LinearGraphqlDirectory({
        getToken: () => provider.getToken(),
        invalidateToken: () => provider.invalidate(),
        authKind: "oauth",
        fetch: fetchImpl,
      });
      directories.set(source.id, directory);
    }
    return directory;
  };

  return {
    resolveIdentifier: (identifier) => current().resolveIdentifier(identifier),
    issuesForUrl: (url) => current().issuesForUrl(url),
  };
}

/** Run the daemon in the foreground until SIGINT/SIGTERM. */
export async function runDaemon(logger: Logger): Promise<void> {
  const daemon = new Daemon(logger);
  await daemon.start();
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void daemon.stop().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  // Lingering source sockets (e.g. a tarpitted IMAP connect) must not keep a
  // cleanly-stopped daemon alive as a zombie.
  process.exit(0);
}
