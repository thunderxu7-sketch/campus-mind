/*
 * Optional visual-interaction lifecycle controller.
 *
 * This module intentionally does not contain an emotion model. It owns only
 * the browser permission, a local preview and a neutral avatar animation. No
 * frames, landmarks, action units or derived labels leave the device. The
 * core expression/support workflow works when this file is unavailable or
 * camera permission is denied.
 */
(() => {
  const startButton = document.querySelector('#visualStart');
  const stopButton = document.querySelector('#visualStop');
  const preview = document.querySelector('#visualPreview');
  const avatar = document.querySelector('#visualAvatar');
  const status = document.querySelector('#visualStatus');
  const root = document.querySelector('#visualInteraction');
  if (!startButton || !stopButton || !preview || !avatar || !status || !root) return;

  let enabled = false;
  let beforeStart = async () => true;
  let stream = null;
  let epoch = 0;
  let timeout = null;
  const MAX_SESSION_MS = 3 * 60 * 1000;

  const setStatus = (message) => { status.textContent = message; };
  const setIdle = () => {
    preview.hidden = true;
    preview.srcObject = null;
    avatar.textContent = '中性互动待机';
    stopButton.disabled = true;
    startButton.disabled = !enabled;
  };
  const stop = (reason = '已停止本地互动并释放摄像头。') => {
    epoch += 1;
    if (timeout) { clearTimeout(timeout); timeout = null; }
    const active = stream;
    stream = null;
    if (active) for (const track of active.getTracks()) track.stop();
    setIdle();
    setStatus(reason);
  };

  const start = async () => {
    if (!enabled || stream || !navigator.mediaDevices?.getUserMedia) {
      if (enabled) setStatus('当前浏览器没有可用的摄像头接口，核心支持功能仍可继续使用。');
      return;
    }
    const currentEpoch = ++epoch;
    startButton.disabled = true;
    setStatus('正在等待你确认摄像头权限；只会在本地预览。');
    try {
      if (!await beforeStart()) { if (currentEpoch === epoch) setIdle(); return; }
      const candidate = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      // Permission may resolve after the user changed account/page. Release
      // the late stream instead of attaching it to a stale view.
      if (currentEpoch !== epoch || !enabled) { for (const track of candidate.getTracks()) track.stop(); return; }
      stream = candidate;
      preview.srcObject = candidate;
      preview.hidden = false;
      stopButton.disabled = false;
      startButton.disabled = true;
      avatar.textContent = '本地互动已开启（无情绪判断）';
      setStatus('摄像头仅在本地工作；不会上传视频或面部数据。');
      timeout = setTimeout(() => stop('达到本次本地互动时长上限，摄像头已释放。'), MAX_SESSION_MS);
    } catch (error) {
      if (currentEpoch !== epoch) return;
      const message = error?.name === 'NotAllowedError' ? '你拒绝了摄像头权限；核心表达与支持功能仍可继续。' : '摄像头暂时不可用；核心表达与支持功能仍可继续。';
      setIdle(); setStatus(message);
    }
  };

  startButton.addEventListener('click', start);
  stopButton.addEventListener('click', () => stop());
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) stop('页面隐藏，已自动停止并释放摄像头。'); });
  window.addEventListener('pagehide', () => stop('页面离开，已停止并释放摄像头。'));
  window.addEventListener('pageshow', () => { if (!stream) setIdle(); });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (stream && !stream.active) stop('摄像头设备已断开，核心功能仍可继续。'); });

  window.CampusMindVisual = Object.freeze({
    configure(options = {}) {
      enabled = options.enabled === true;
      beforeStart = typeof options.beforeStart === 'function' ? options.beforeStart : async () => true;
      root.hidden = !enabled;
      root.dataset.enabled = String(enabled);
      if (!enabled) stop('视觉互动未启用；核心表达与支持功能仍可继续。'); else setIdle();
    },
    stop,
  });
  setIdle();
})();
