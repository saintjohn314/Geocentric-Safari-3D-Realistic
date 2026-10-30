// Quick WebGL check without loading three.js: is WebGL 2 available, and is it real graphics
// hardware rather than a software fallback (which would make the 3D view crawl)?
export function probeGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (!gl) return { ok: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const software = /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen/i.test(name);
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok: true, software, name, maxTex };
  } catch {
    return { ok: false };
  }
}
