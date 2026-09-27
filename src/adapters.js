export class RunwayAdapterBoundary {
  async generateVideo(_request) {
    throw new Error("Runway adapter not configured");
  }
}

export class DescriptAdapterBoundary {
  async transcribe(_request) {
    throw new Error("Descript adapter not configured");
  }

  async synthesizeVoice(_request) {
    throw new Error("Descript adapter not configured");
  }
}

function requireMethod(adapter, method, name) {
  if (adapter !== null && adapter !== undefined && typeof adapter[method] !== "function") {
    throw new TypeError(`${name} adapter must implement ${method}()`);
  }
}

export function createProviderBoundaries({ runway = null, descript = null } = {}) {
  requireMethod(runway, "generateVideo", "Runway");
  requireMethod(descript, "transcribe", "Descript");
  requireMethod(descript, "synthesizeVoice", "Descript");
  return { runway, descript };
}
