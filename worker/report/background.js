import { backgroundShader } from './background-shader.js';

// Serialize only the browser entry and its WGSL. The report also builds as one portable Worker.
export function reportBackgroundScript() {
  return '(' + startReportBackground.toString() + ')(' + JSON.stringify(backgroundShader) + ');';
}

function startReportBackground(shaderCode) {
  const canvas = document.getElementById('report-background');
  const message = document.getElementById('gpu-status');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let unmount;

  async function getWebGPUSupport() {
    if (!navigator.gpu) throw new Error('此瀏覽器未提供 WebGPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
    if (!adapter || adapter.info?.isFallbackAdapter) {
      throw new Error('找不到可用的 WebGPU 硬體');
    }
    return adapter.requestDevice();
  }

  function mount() {
    let device;
    let context;
    let uniformBuffer;
    let frame = 0;
    let stopped = false;
    let inView = false;
    let firstFrame = false;
    let dirty = true;
    let clock = 0;
    let lastTick = 0;
    let draw;
    const values = new Float32Array(4);

    canvas.dataset.gpu = 'checking';
    message.hidden = true;

    function dispose() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame);
      viewport.disconnect();
      size.disconnect();
      motion.removeEventListener('change', reconcile);
      document.removeEventListener('visibilitychange', reconcile);
      delete canvas.captureReportBackground;
      context?.unconfigure();
      uniformBuffer?.destroy();
      device?.destroy();
    }

    function fail(error) {
      if (stopped) return;
      dispose();
      canvas.dataset.gpu = 'unavailable';
      message.textContent = '即時背景無法啟用。' + error.message + '。';
      message.hidden = false;
      console.error('[report WebGPU]', error);
    }

    function reconcile() {
      if (stopped || !draw) return;
      if (!inView || document.hidden || (motion.matches && firstFrame && !dirty)) {
        cancelAnimationFrame(frame);
        frame = 0;
        lastTick = 0;
        if (firstFrame && canvas.dataset.gpu !== 'paused') canvas.dataset.gpu = 'paused';
        return;
      }
      if (firstFrame && canvas.dataset.gpu !== 'ready') canvas.dataset.gpu = 'ready';
      if (!frame) frame = requestAnimationFrame(tick);
    }

    function tick(now) {
      frame = 0;
      // The background moves slowly, so cap it at 30 fps.
      if (!dirty && lastTick && now - lastTick < 32) {
        reconcile();
        return;
      }
      if (lastTick && !motion.matches) clock += Math.min((now - lastTick) / 1000, 0.1);
      lastTick = now;
      try {
        if (!draw()) return;
        dirty = false;
        if (!firstFrame) {
          // Confirm that the device executed the first frame before showing the canvas.
          firstFrame = true;
          device.queue.onSubmittedWorkDone().then(() => {
            if (stopped) return;
            canvas.dataset.painted = 'true';
            reconcile();
          }, fail);
        }
        reconcile();
      } catch (error) {
        fail(error);
      }
    }

    const viewport = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      reconcile();
    });
    const size = new ResizeObserver(() => {
      dirty = true;
      reconcile();
    });
    viewport.observe(canvas);
    size.observe(canvas);
    motion.addEventListener('change', reconcile);
    document.addEventListener('visibilitychange', reconcile);

    (async () => {
      const gpu = await getWebGPUSupport();
      if (stopped) {
        gpu.destroy();
        return;
      }
      device = gpu;
      device.lost.then(info => fail(new Error('WebGPU 裝置中斷（' + info.reason + '）')));
      device.addEventListener('uncapturederror', event => fail(event.error));
      context = canvas.getContext('webgpu');
      if (!context) throw new Error('無法建立 WebGPU 畫布');

      const format = navigator.gpu.getPreferredCanvasFormat();
      const module = device.createShaderModule({ code: shaderCode, label: 'Wallet report blue silk' });
      const errors = (await module.getCompilationInfo()).messages.filter(info => info.type === 'error');
      if (stopped) return;
      if (errors.length) throw new Error(errors.map(info => info.message).join('\n'));
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'fullscreen' },
        fragment: { module, entryPoint: 'flow', targets: [{ format }] },
      });
      if (stopped) return;
      context.configure({ device, format, alphaMode: 'opaque' });
      uniformBuffer = device.createBuffer({
        size: values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });

      draw = () => {
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (!width || !height) return false;
        const scale = Math.min(window.devicePixelRatio || 1, 1.25, Math.sqrt(1_250_000 / (width * height)));
        const pixelWidth = Math.max(1, Math.round(width * scale));
        const pixelHeight = Math.max(1, Math.round(height * scale));
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        values[0] = pixelWidth;
        values[1] = pixelHeight;
        values[2] = clock;
        device.queue.writeBuffer(uniformBuffer, 0, values);

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        return true;
      };
      canvas.captureReportBackground = () => {
        if (stopped || !draw()) return null;
        const snapshot = document.createElement('canvas');
        snapshot.width = canvas.width;
        snapshot.height = canvas.height;
        snapshot.getContext('2d').drawImage(canvas, 0, 0);
        return snapshot;
      };
      reconcile();
    })().catch(fail);

    return dispose;
  }

  unmount = mount();
  window.addEventListener('pagehide', () => {
    unmount();
    delete canvas.dataset.painted;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) unmount = mount();
  });
}
