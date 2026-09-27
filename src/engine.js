import { buildRenderPlan } from "./plan.js";
import { compileFfmpegCommand } from "./ffmpeg.js";
import { evaluateRenderQa } from "./qa.js";
import { buildExportMetadata, createRenderJob, transitionRenderJob } from "./jobs.js";
import { createProviderBoundaries } from "./adapters.js";

export class MediaEngine {
  constructor({ executor, probe, runway = null, descript = null, qaThresholds = {} }) {
    if (!executor || typeof executor.run !== "function") throw new TypeError("executor.run is required");
    if (!probe || typeof probe.inspect !== "function") throw new TypeError("probe.inspect is required");
    this.executor = executor;
    this.probe = probe;
    this.providers = createProviderBoundaries({ runway, descript });
    this.qaThresholds = qaThresholds;
  }

  async render({ jobId, timeline, exportSpec = {}, outputPath, completedAt = null }) {
    let job = createRenderJob({ id: jobId, timelineId: timeline.id, outputPath });
    try {
      job = transitionRenderJob(job, "start");
      const plan = buildRenderPlan(timeline, exportSpec);
      job = transitionRenderJob(job, "planned", { renderFingerprint: plan.fingerprint });
      const command = compileFfmpegCommand(timeline, exportSpec, outputPath);
      await this.executor.run(command);
      job = transitionRenderJob(job, "rendered");
      const probe = await this.probe.inspect(outputPath);
      const qa = evaluateRenderQa(timeline, probe, this.qaThresholds);
      if (!qa.passed) {
        job = transitionRenderJob(job, "qa_failed", { qa });
        return { job, plan, command, probe, qa, exportMetadata: null };
      }
      job = transitionRenderJob(job, "qa_passed", { qa });
      return {
        job,
        plan,
        command,
        probe,
        qa,
        exportMetadata: buildExportMetadata({ job, plan, probe, qa, completedAt })
      };
    } catch (error) {
      if (job.status !== "failed" && job.status !== "completed") {
        job = transitionRenderJob(job, "fail", { error: { name: error.name, message: error.message } });
      }
      return { job, error, exportMetadata: null };
    }
  }
}
