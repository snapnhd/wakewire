import { isDeepStrictEqual } from "node:util";
import { type DispatcherDefaultAgent, loadDispatcherDefaultAgent, settingKeys } from "../config.js";
import type { WakeEvent } from "../core/event.js";
import type { Database } from "../db/db.js";
import type { SettingsStore } from "../db/repos.js";
import type { PeopleStore } from "../people/store.js";
import { isPrivilegedSlackUserEvent } from "../sources/slack/normalize.js";
import { parseDispatcherDefaultDirective } from "./claude-trigger.js";
import type { AgentCoordinator } from "./coordinator.js";
import { effectivePolicy, isEnforceableDesktopOwner, PolicyConfigurationError } from "./policy.js";
import { buildFinalReplySpec } from "./reply.js";
import type { AgentRequestStore } from "./store.js";
import { requestText } from "./targeting.js";

const CONTROL_KIND = "dispatcher-default-agent";
const CONTROL_MARKER_PREFIX = `wakewire:host-control:v1:${CONTROL_KIND}:`;

export interface DispatcherControlAcceptance {
  claimed: boolean;
  accepted: boolean;
  duplicate?: boolean | undefined;
  requestId?: string | undefined;
  replyQueued?: boolean | undefined;
  defaultAgent?: DispatcherDefaultAgent | undefined;
  reason?: string | undefined;
}

/**
 * Host-owned Slack control plane for the default model route. It is deliberately
 * narrower than ordinary owner dispatch: the immutable Slack principal must
 * resolve to the locally enrolled CJ record with the exact seeded owner policy.
 */
export class DispatcherControlCoordinator {
  constructor(
    private readonly db: Database,
    private readonly people: PeopleStore,
    private readonly requests: AgentRequestStore,
    private readonly settings: SettingsStore,
    private readonly agent: AgentCoordinator,
  ) {}

  accept(event: WakeEvent): DispatcherControlAcceptance {
    const sourceId = event.sourceId?.trim() ?? "";
    if (!sourceId) return { claimed: false, accepted: false };

    const replay = this.requests.findByDelivery(sourceId, event.deliveryId);
    if (replay?.correlationMarker?.startsWith(CONTROL_MARKER_PREFIX)) {
      if (!isDeepStrictEqual(replay.event, event)) {
        return {
          claimed: true,
          accepted: false,
          reason: "dispatcher control delivery id was replayed with different event content",
        };
      }
      return {
        claimed: true,
        accepted: true,
        duplicate: true,
        requestId: replay.id,
        replyQueued: true,
        defaultAgent: loadDispatcherDefaultAgent(this.settings),
      };
    }
    if (event.source !== "slack") return { claimed: false, accepted: false };
    if (replay) return { claimed: false, accepted: false };

    const recipientUser = payloadString(event, "recipientUser");
    const directive = parseDispatcherDefaultDirective(requestText(event), recipientUser);
    if (!directive) return { claimed: false, accepted: false };
    if (!isPrivilegedSlackUserEvent(event)) {
      return {
        claimed: true,
        accepted: false,
        reason: "dispatcher control requires an authenticated exact Chip mention",
      };
    }

    const authorization = this.authorizeCjOwner(event);
    if (authorization) return { claimed: true, accepted: false, reason: authorization };

    const previous = loadDispatcherDefaultAgent(this.settings);
    const response = confirmationText(directive.defaultAgent, previous === directive.defaultAgent);
    try {
      const spec = buildFinalReplySpec(event, response);
      const committed = this.db.transaction(() => {
        const accepted = this.agent.accept(event);
        if (!accepted.addressed || !accepted.accepted || !accepted.requestId) {
          throw new DispatcherControlError(accepted.reason ?? "ordinary authorization failed");
        }
        if (accepted.duplicate) {
          throw new DispatcherControlError("delivery is already bound to another request");
        }
        this.settings.set(settingKeys.dispatcherDefaultAgent, directive.defaultAgent);
        this.requests.stageHostControlReply({
          requestId: accepted.requestId,
          controlKind: CONTROL_KIND,
          spec,
        });
        return accepted;
      })();
      return {
        claimed: true,
        accepted: true,
        duplicate: false,
        requestId: committed.requestId,
        replyQueued: true,
        defaultAgent: directive.defaultAgent,
      };
    } catch (error) {
      return {
        claimed: true,
        accepted: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private authorizeCjOwner(event: WakeEvent): string | null {
    const principal = event.principal;
    if (principal?.provider !== "slack") return "dispatcher control requires a Slack principal";
    const enrolledCj = this.people.getByNickname("CJ");
    const resolved = this.people.resolveIdentity("slack", principal.tenantId, principal.subjectId);
    if (!enrolledCj || !resolved || resolved.person.id !== enrolledCj.id) {
      return "dispatcher control is restricted to the enrolled CJ principal";
    }
    try {
      const policy = effectivePolicy(this.people, resolved.person.id);
      if (!policy || !isEnforceableDesktopOwner(policy)) {
        return "dispatcher control requires the exact enabled owner policy";
      }
    } catch (error) {
      if (error instanceof PolicyConfigurationError) return error.message;
      throw error;
    }
    return null;
  }
}

class DispatcherControlError extends Error {}

function confirmationText(agent: DispatcherDefaultAgent, unchanged: boolean): string {
  const label = agent === "claude-rc" ? "Claude RC" : "Codex Desktop";
  const verb = unchanged ? "is already" : "changed to";
  return `Default agent ${verb} ${label} for new Slack conversations. Active sessions are unchanged.`;
}

function payloadString(event: WakeEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value.trim() : "";
}
