(function () {
  'use strict';

  const BAR_COUNT = 64;
  const PARTICLE_FADE = 'rgba(5, 8, 16, 0.18)';
  const SILENCE_THRESHOLD = 0.02;
  const DRAG_CLICK_THRESHOLD = 6;

  const THEMES = {
    neon: {
      bg: '#050810',
      wave: '#39ff14',
      waveGlow: 'rgba(57, 255, 20, 0.25)',
      spectrumStart: '#ff00aa',
      spectrumEnd: '#00e5ff',
      particlePalette: ['#39ff14', '#00ffcc', '#ff00aa', '#ffe600', '#7fff00']
    },
    sunset: {
      bg: '#120808',
      wave: '#ff6b35',
      waveGlow: 'rgba(255, 107, 53, 0.3)',
      spectrumStart: '#ff2e63',
      spectrumEnd: '#ffdd57',
      particlePalette: ['#ff6b35', '#ff2e63', '#ffdd57', '#ff9a3c', '#e85d04']
    },
    ocean: {
      bg: '#040a12',
      wave: '#4cc9f0',
      waveGlow: 'rgba(76, 201, 240, 0.28)',
      spectrumStart: '#023e8a',
      spectrumEnd: '#90e0ef',
      particlePalette: ['#4cc9f0', '#4895ef', '#560bad', '#3a0ca3', '#90e0ef']
    },
    candy: {
      bg: '#0d0812',
      wave: '#f72585',
      waveGlow: 'rgba(247, 37, 133, 0.28)',
      spectrumStart: '#b5179e',
      spectrumEnd: '#4cc9f0',
      particlePalette: ['#f72585', '#7209b7', '#3a86ff', '#ffbe0b', '#fb5607']
    }
  };

  const canvasWrap = document.getElementById('canvasWrap');
  const trailCanvas = document.getElementById('trailCanvas');
  const vizCanvas = document.getElementById('vizCanvas');
  const particleCanvas = document.getElementById('particleCanvas');
  const statusBar = document.getElementById('statusBar');
  const canvasHint = document.getElementById('canvasHint');
  const privacyPanel = document.getElementById('privacyPanel');

  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnClear = document.getElementById('btnClear');
  const btnSave = document.getElementById('btnSave');
  const themeSelect = document.getElementById('themeSelect');
  const simulateMode = document.getElementById('simulateMode');
  const privacyDismiss = document.getElementById('privacyDismiss');

  const trailCtx = trailCanvas.getContext('2d');
  const vizCtx = vizCanvas.getContext('2d');
  const particleCtx = particleCanvas.getContext('2d');

  let audioContext = null;
  let analyser = null;
  let mediaStream = null;
  let sourceNode = null;
  let isRunning = false;
  let isSimulating = false;
  let simulatePhase = 0;
  let animationId = null;

  let timeData = null;
  let freqData = null;

  let particles = [];
  let isPointerDown = false;
  let hasDragged = false;
  let lastTrailX = 0;
  let lastTrailY = 0;
  let pointerDownX = 0;
  let pointerDownY = 0;

  let width = 0;
  let height = 0;
  let currentTheme = 'neon';

  function setStatus(message, type) {
    statusBar.textContent = message;
    statusBar.className = 'status-bar' + (type ? ' ' + type : '');
  }

  function getTheme() {
    return THEMES[currentTheme] || THEMES.neon;
  }

  function loadPreferences() {
    try {
      const saved = localStorage.getItem('soundDoodleTheme');
      if (saved && THEMES[saved]) {
        currentTheme = saved;
        themeSelect.value = saved;
      }
      if (localStorage.getItem('soundDoodlePrivacyDismissed') === '1') {
        privacyPanel.classList.add('dismissed');
      }
    } catch (_) {
      /* localStorage unavailable */
    }
  }

  function saveThemePreference() {
    try {
      localStorage.setItem('soundDoodleTheme', currentTheme);
    } catch (_) {
      /* ignore */
    }
  }

  function resizeCanvases() {
    const rect = canvasWrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.floor(rect.width);
    height = Math.floor(rect.height);

    [trailCanvas, vizCanvas, particleCanvas].forEach(function (canvas) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });

    if (!isRunning) {
      clearVizLayer();
      clearParticleLayer();
    }
  }

  function getVolume(data) {
    if (!data || !data.length) return 0;
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  function getDominantFrequencyIndex(data) {
    if (!data || !data.length) return 0;
    let maxVal = 0;
    let maxIdx = 0;
    const start = Math.floor(data.length * 0.02);
    for (let i = start; i < data.length; i++) {
      if (data[i] > maxVal) {
        maxVal = data[i];
        maxIdx = i;
      }
    }
    return maxIdx;
  }

  function frequencyToHue(freqIndex, dataLength) {
    const ratio = freqIndex / Math.max(dataLength - 1, 1);
    if (ratio < 0.33) return 15 + ratio * 90;
    if (ratio < 0.66) return 100 + (ratio - 0.33) * 60;
    return 200 + (ratio - 0.66) * 100;
  }

  function frequencyToParticleColor(freqIndex, dataLength) {
    const hue = frequencyToHue(freqIndex, dataLength);
    return 'hsl(' + hue + ', 85%, 58%)';
  }

  function fillSimulatedData() {
    simulatePhase += 0.08;
    const vol = 0.25 + 0.2 * Math.sin(simulatePhase * 0.7);
    for (let i = 0; i < timeData.length; i++) {
      const t = (i / timeData.length) * Math.PI * 8 + simulatePhase;
      const wave = Math.sin(t) * 40 * vol + Math.sin(t * 2.3) * 15 * vol;
      timeData[i] = Math.max(0, Math.min(255, 128 + wave + (Math.random() - 0.5) * 6));
    }
    for (let i = 0; i < freqData.length; i++) {
      const peak = Math.floor((0.15 + 0.1 * Math.sin(simulatePhase)) * freqData.length);
      const dist = Math.abs(i - peak);
      const energy = Math.max(0, 180 * vol - dist * 2.5) + Math.random() * 12;
      freqData[i] = Math.min(255, energy);
    }
  }

  function readAudioData() {
    if (isSimulating) {
      fillSimulatedData();
      return;
    }
    if (!analyser) return;
    analyser.getByteTimeDomainData(timeData);
    analyser.getByteFrequencyData(freqData);
  }

  function drawWaveform() {
    const theme = getTheme();
    const centerY = height * 0.5;
    const sliceWidth = width / timeData.length;
    const ampScale = height * 0.22;

    vizCtx.strokeStyle = theme.wave;
    vizCtx.lineWidth = 2;
    vizCtx.lineJoin = 'round';
    vizCtx.lineCap = 'round';
    vizCtx.shadowColor = theme.waveGlow;
    vizCtx.shadowBlur = 8;

    vizCtx.beginPath();
    let x = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = timeData[i];
      const y = centerY + ((v - 128) / 128) * ampScale;
      if (i === 0) {
        vizCtx.moveTo(x, y);
      } else {
        vizCtx.lineTo(x, y);
      }
      x += sliceWidth;
    }
    vizCtx.stroke();
    vizCtx.shadowBlur = 0;

    vizCtx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    vizCtx.lineWidth = 1;
    vizCtx.beginPath();
    vizCtx.moveTo(0, centerY);
    vizCtx.lineTo(width, centerY);
    vizCtx.stroke();
  }

  function drawSpectrum() {
    const theme = getTheme();
    const barAreaTop = height * 0.58;
    const barAreaHeight = height * 0.36;
    const gap = 1;
    const barWidth = (width - gap * (BAR_COUNT + 1)) / BAR_COUNT;
    const binSize = Math.floor(freqData.length / BAR_COUNT);

    for (let i = 0; i < BAR_COUNT; i++) {
      let sum = 0;
      const start = i * binSize;
      const end = start + binSize;
      for (let j = start; j < end; j++) {
        sum += freqData[j];
      }
      const avg = sum / binSize;
      const barH = (avg / 255) * barAreaHeight;
      const x = gap + i * (barWidth + gap);
      const y = barAreaTop + barAreaHeight - barH;

      const gradient = vizCtx.createLinearGradient(x, y + barH, x, y);
      const t = i / (BAR_COUNT - 1);
      gradient.addColorStop(0, theme.spectrumStart);
      gradient.addColorStop(1, theme.spectrumEnd);
      vizCtx.fillStyle = gradient;
      vizCtx.globalAlpha = 0.75;
      vizCtx.fillRect(x, y, barWidth, barH);
    }
    vizCtx.globalAlpha = 1;
  }

  function clearVizLayer() {
    const theme = getTheme();
    vizCtx.fillStyle = theme.bg;
    vizCtx.fillRect(0, 0, width, height);
  }

  function clearParticleLayer() {
    const theme = getTheme();
    particleCtx.fillStyle = theme.bg;
    particleCtx.fillRect(0, 0, width, height);
  }

  function spawnParticles(x, y, volume, freqIndex) {
    const count = 20 + Math.floor(Math.random() * 21);
    const theme = getTheme();
    const baseSpeed = 1.5 + volume * 12;
    const dominantColor = frequencyToParticleColor(freqIndex, freqData.length);

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = baseSpeed * (0.6 + Math.random() * 0.8);
      const useDominant = Math.random() > 0.35;
      const color = useDominant
        ? dominantColor
        : theme.particlePalette[Math.floor(Math.random() * theme.particlePalette.length)];

      particles.push({
        x: x,
        y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 5 + Math.random() * 10,
        life: 1,
        decay: 0.012 + Math.random() * 0.018,
        color: color
      });
    }
  }

  function updateParticles() {
    particleCtx.fillStyle = PARTICLE_FADE;
    particleCtx.fillRect(0, 0, width, height);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.98;
      p.vy *= 0.98;
      p.life -= p.decay;
      p.radius *= 0.985;

      if (p.life <= 0 || p.radius < 0.5) {
        particles.splice(i, 1);
        continue;
      }

      particleCtx.beginPath();
      particleCtx.globalAlpha = p.life * 0.9;
      particleCtx.fillStyle = p.color;
      particleCtx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      particleCtx.fill();
    }
    particleCtx.globalAlpha = 1;
  }

  function trailColor(x, volume) {
    const hue = (x / width) * 360;
    const saturation = 35 + Math.min(volume, 1) * 65;
    const lightness = 52;
    return 'hsla(' + hue + ', ' + saturation + '%, ' + lightness + '%, 0.72)';
  }

  function trailWidth(y, volume) {
    const base = 1 + (y / height) * 19;
    const volumeBoost = 1 + Math.min(volume, 1) * 0.5;
    return base * volumeBoost;
  }

  function drawTrailSegment(x0, y0, x1, y1, volume) {
    const jitter = volume > SILENCE_THRESHOLD
      ? function () { return (Math.random() - 0.5) * 10; }
      : function () { return 0; };

    const jx0 = x0 + jitter();
    const jy0 = y0 + jitter();
    const jx1 = x1 + jitter();
    const jy1 = y1 + jitter();

    trailCtx.strokeStyle = trailColor((x0 + x1) / 2, volume);
    trailCtx.lineWidth = trailWidth((y0 + y1) / 2, volume);
    trailCtx.lineCap = 'round';
    trailCtx.lineJoin = 'round';

    trailCtx.beginPath();
    trailCtx.moveTo(jx0, jy0);
    trailCtx.lineTo(jx1, jy1);
    trailCtx.stroke();
  }

  function getPointerPos(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    let clientX;
    let clientY;
    if (event.changedTouches && event.changedTouches.length) {
      clientX = event.changedTouches[0].clientX;
      clientY = event.changedTouches[0].clientY;
    } else if (event.touches && event.touches.length) {
      clientX = event.touches[0].clientX;
      clientY = event.touches[0].clientY;
    } else {
      clientX = event.clientX;
      clientY = event.clientY;
    }
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    const pos = getPointerPos(particleCanvas, event);
    isPointerDown = true;
    hasDragged = false;
    pointerDownX = pos.x;
    pointerDownY = pos.y;
    lastTrailX = pos.x;
    lastTrailY = pos.y;
  }

  function onPointerMove(event) {
    if (!isPointerDown) return;
    event.preventDefault();
    const pos = getPointerPos(particleCanvas, event);
    const dx = pos.x - pointerDownX;
    const dy = pos.y - pointerDownY;
    if (Math.hypot(dx, dy) > DRAG_CLICK_THRESHOLD) {
      hasDragged = true;
    }

    const volume = timeData ? getVolume(timeData) : 0;
    drawTrailSegment(lastTrailX, lastTrailY, pos.x, pos.y, volume);
    lastTrailX = pos.x;
    lastTrailY = pos.y;
  }

  function onPointerUp(event) {
    if (!isPointerDown) return;
    event.preventDefault();
    const pos = getPointerPos(particleCanvas, event);

    if (!hasDragged && isRunning) {
      const volume = timeData ? getVolume(timeData) : 0.15;
      const freqIdx = freqData ? getDominantFrequencyIndex(freqData) : 0;
      spawnParticles(pos.x, pos.y, volume, freqIdx);
    }

    isPointerDown = false;
    hasDragged = false;
  }

  function animationLoop() {
    if (!isRunning) return;

    readAudioData();
    const volume = getVolume(timeData);

    clearVizLayer();
    drawWaveform();
    drawSpectrum();
    updateParticles();

    animationId = requestAnimationFrame(animationLoop);
  }

  async function startDoodle() {
    if (isRunning) return;

    isSimulating = simulateMode.checked;

    if (!isSimulating) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus('当前浏览器不支持麦克风访问，请使用 Chrome 或 Edge，或勾选「模拟声波」', 'error');
        return;
      }

      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        const denied = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
        setStatus(
          denied
            ? '麦克风授权失败，请允许浏览器使用麦克风后重试，或勾选「模拟声波」进行演示'
            : '无法获取麦克风：' + (err.message || '请检查设备连接'),
          'error'
        );
        return;
      }
    }

    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.75;

      timeData = new Uint8Array(analyser.fftSize);
      freqData = new Uint8Array(analyser.frequencyBinCount);

      if (!isSimulating && mediaStream) {
        sourceNode = audioContext.createMediaStreamSource(mediaStream);
        sourceNode.connect(analyser);
      }

      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
    } catch (err) {
      stopDoodle();
      setStatus('音频初始化失败：' + (err.message || '未知错误'), 'error');
      return;
    }

    isRunning = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    simulateMode.disabled = true;
    canvasHint.classList.add('hidden');

    particles = [];
    clearParticleLayer();

    setStatus(
      isSimulating
        ? '模拟声波模式已启动，可发声互动或直接使用鼠标涂鸦'
        : '涂鸦进行中 · 对着麦克风发声，拖动绘制轨迹，点击产生粒子',
      'success'
    );

    animationLoop();
  }

  function stopDoodle() {
    isRunning = false;
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }

    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch (_) {
        /* ignore */
      }
      sourceNode = null;
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach(function (track) {
        track.stop();
      });
      mediaStream = null;
    }

    if (audioContext) {
      audioContext.close().catch(function () {});
      audioContext = null;
    }

    analyser = null;
    timeData = null;
    freqData = null;
    isSimulating = false;

    btnStart.disabled = false;
    btnStop.disabled = true;
    simulateMode.disabled = false;
    canvasHint.classList.remove('hidden');

    setStatus('已停止涂鸦，麦克风已关闭', '');
  }

  function clearAll() {
    trailCtx.clearRect(0, 0, width, height);
    particles = [];
    clearVizLayer();
    clearParticleLayer();
    setStatus('画布已清空', 'success');
  }

  function saveWork() {
    const exportCanvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    exportCanvas.width = width * dpr;
    exportCanvas.height = height * dpr;
    const ctx = exportCanvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const theme = getTheme();
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);

    [trailCanvas, vizCanvas, particleCanvas].forEach(function (canvas) {
      ctx.drawImage(canvas, 0, 0, width, height);
    });

    exportCanvas.toBlob(function (blob) {
      if (!blob) {
        setStatus('导出失败，请重试', 'error');
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      link.download = '声音涂鸦-' + stamp + '.png';
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
      setStatus('作品已保存为 PNG 图片', 'success');
    }, 'image/png');
  }

  function bindEvents() {
    btnStart.addEventListener('click', startDoodle);
    btnStop.addEventListener('click', stopDoodle);
    btnClear.addEventListener('click', clearAll);
    btnSave.addEventListener('click', saveWork);

    themeSelect.addEventListener('change', function () {
      currentTheme = themeSelect.value;
      saveThemePreference();
      if (!isRunning) {
        clearVizLayer();
        clearParticleLayer();
      }
    });

    privacyDismiss.addEventListener('click', function () {
      privacyPanel.classList.add('dismissed');
      try {
        localStorage.setItem('soundDoodlePrivacyDismissed', '1');
      } catch (_) {
        /* ignore */
      }
    });

    window.addEventListener('resize', resizeCanvases);

    const target = particleCanvas;
    target.addEventListener('mousedown', onPointerDown);
    target.addEventListener('mousemove', onPointerMove);
    target.addEventListener('mouseup', onPointerUp);
    target.addEventListener('mouseleave', function (e) {
      if (isPointerDown) onPointerUp(e);
    });

    target.addEventListener('touchstart', onPointerDown, { passive: false });
    target.addEventListener('touchmove', onPointerMove, { passive: false });
    target.addEventListener('touchend', onPointerUp, { passive: false });
    target.addEventListener('touchcancel', onPointerUp, { passive: false });

    target.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });
  }

  function init() {
    loadPreferences();
    resizeCanvases();
    clearVizLayer();
    clearParticleLayer();
    bindEvents();
    setStatus('点击「开始涂鸦」授权麦克风，开始声音可视化创作', '');
  }

  init();
})();
