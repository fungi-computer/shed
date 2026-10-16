import { DurableObject } from "cloudflare:workers";
import { appBackend, type ShedMethodContext } from "./methods.js";
import { createShedRuns } from "./runs.js";
class ShedFacet extends DurableObject<ShedMethodContext["env"]> {
  declare public readonly env: ShedMethodContext["env"];
  readonly runs;
  constructor(ctx: DurableObjectState, env: ShedMethodContext["env"]) {
    super(ctx, env);
    this.runs = createShedRuns(ctx.storage.sql);
  }
  override fetch(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 405 }));
  }
}
export const Shed = appBackend.implement(ShedFacet);
