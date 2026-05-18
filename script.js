/**
 * 声音涂鸦 - 主脚本
 * 里程碑 M2：音频核心 | M3：实时声波波形
 *
 * 模块划分：
 * - BrowserSupport   浏览器兼容性检测
 * - AudioEngine      麦克风授权、AnalyserNode、音频数据封装
 * - WaveformRenderer 示波器风格实时波形绘制
 * - AppUI            画布、按钮、状态栏
 */

(function () {
  'use strict';

  var FFT_SIZE = 1024;

  /* ==========================================================================
   * BrowserSupport - 浏览器兼容性
   * ========================================================================== */
  var BrowserSupport = {
    isSupported: false,

    /**
     * 检测是否为 Chrome 或 Edge（计划书目标浏览器）
     * @returns {boolean}
     */
    check: function () {
      var ua = navigator.userAgent;
      var isEdge = ua.indexOf('Edg/') !== -1;
      var isChrome =
        ua.indexOf('Chrome/') !== -1 &&
        ua.indexOf('Edg/') === -1 &&
        ua.indexOf('OPR/') === -1;
      this.isSupported = isEdge || isChrome;
      return this.isSupported;
    },

    /**
     * 是否支持 getUserMedia
     * @returns {boolean}
     */
    hasMediaDevices: function () {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }
  };

  /* ==========================================================================
   * AudioEngine - 音频采集与分析
   * ========================================================================== */
  var AudioEngine = {
    audioContext: null,
    analyser: null,
    mediaStream: null,
    sourceNode: null,
    timeBuffer: null,
    freqBuffer: null,
    isInitialized: false,

    /**
     * 创建 AudioContext 与 AnalyserNode（fftSize = 1024）
     * @returns {boolean}
     */
    init: function () {
      if (this.isInitialized) {
        return true;
      }

      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        return false;
      }

      this.audioContext = new AudioCtx();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      /* 略降低平滑系数，使波形响应更快（配合 rAF 满足 ≤100ms 主观延迟） */
      this.analyser.smoothingTimeConstant = 0.65;


      this.timeBuffer = new Uint8Array(this.analyser.fftSize);
      this.freqBuffer = new Uint8Array(this.analyser.frequencyBinCount);
      this.isInitialized = true;
      return true;
    },

    /**
     * 请求麦克风权限并获取音频流
     * @returns {Promise<void>}
     */
    requestMicrophone: function () {
      var self = this;

      if (!BrowserSupport.hasMediaDevices()) {
        return Promise.reject(new Error('当前浏览器不支持麦克风访问，请使用 Chrome 或 Edge'));
      }

      if (!this.isInitialized && !this.init()) {
        return Promise.reject(new Error('音频引擎初始化失败，请刷新页面重试'));
      }

      return navigator.mediaDevices
        .getUserMedia({ audio: true, video: false })
        .then(function (stream) {
          self.mediaStream = stream;
          self._connectSource();
          return self._resumeContext();
        });
    },

    /**
     * 将麦克风流接入分析节点
     * @private
     */
    _connectSource: function () {
      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect();
        } catch (e) {
          /* ignore */
        }
      }
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.analyser);
    },

    /**
     * 恢复 AudioContext（需用户手势触发）
     * @private
     * @returns {Promise<void>}
     */
    _resumeContext: function () {
      if (this.audioContext.state === 'suspended') {
        return this.audioContext.resume();
      }
      return Promise.resolve();
    },

    /**
     * 解析 getUserMedia 错误为中文提示
     * @param {Error|DOMException} err
     * @returns {string}
     */
    getErrorMessage: function (err) {
      var name = err && err.name ? err.name : '';

      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        return '麦克风授权失败，请在浏览器地址栏允许麦克风权限后重试';
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return '未检测到麦克风设备，请连接麦克风后重试';
      }
      if (name === 'NotReadableError' || name === 'TrackStartError') {
        return '麦克风被其他应用占用，请关闭占用程序后重试';
      }
      if (name === 'SecurityError') {
        return '安全限制导致无法访问麦克风，请使用 HTTPS 或 localhost 打开页面';
      }
      if (name === 'AbortError') {
        return '麦克风授权已取消，请重新点击「开始涂鸦」';
      }

      return (err && err.message) || '无法获取麦克风，请重试';
    },

    /**
     * 获取实时时域数据（0–255，128 为零点）
     * @returns {Uint8Array}
     */
    getTimeDomainData: function () {
      if (!this.analyser) {
        return this.timeBuffer;
      }
      this.analyser.getByteTimeDomainData(this.timeBuffer);
      return this.timeBuffer;
    },

    /**
     * 获取实时频域数据（0–255，各频段能量）
     * @returns {Uint8Array}
     */
    getFrequencyData: function () {
      if (!this.analyser) {
        return this.freqBuffer;
      }
      this.analyser.getByteFrequencyData(this.freqBuffer);
      return this.freqBuffer;
    },

    /**
     * 计算平均音量（时域 RMS，归一化到 0–1）
     * @param {Uint8Array} [timeData]
     * @returns {number}
     */
    getAverageVolume: function (timeData) {
      var data = timeData || this.getTimeDomainData();
      if (!data || !data.length) {
        return 0;
      }

      var sum = 0;
      for (var i = 0; i < data.length; i++) {
        var sample = (data[i] - 128) / 128;
        sum += sample * sample;
      }
      return Math.sqrt(sum / data.length);
    },

    /**
     * 获取主导频率（能量最大频段）
     * @param {Uint8Array} [freqData]
     * @returns {{ index: number, hz: number, magnitude: number }}
     */
    getDominantFrequency: function (freqData) {
      var data = freqData || this.getFrequencyData();
      var maxIdx = 0;
      var maxVal = 0;

      /* 跳过直流分量（bin 0） */
      for (var i = 1; i < data.length; i++) {
        if (data[i] > maxVal) {
          maxVal = data[i];
          maxIdx = i;
        }
      }

      var sampleRate = this.audioContext ? this.audioContext.sampleRate : 44100;
      var hz = (maxIdx * sampleRate) / this.analyser.fftSize;

      return {
        index: maxIdx,
        hz: Math.round(hz),
        magnitude: maxVal
      };
    },

    /**
     * 释放麦克风与音频资源
     */
    dispose: function () {
      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect();
        } catch (e) {
          /* ignore */
        }
        this.sourceNode = null;
      }

      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(function (track) {
          track.stop();
        });
        this.mediaStream = null;
      }

      if (this.audioContext) {
        var ctx = this.audioContext;
        this.audioContext = null;
        this.analyser = null;
        this.isInitialized = false;
        ctx.close().catch(function () {});
      }
    }
  };

  /* ==========================================================================
   * WaveformRenderer - 实时声波波形（示波器风格）
   * ========================================================================== */
  var WaveformRenderer = {
    COLOR: '#39ff14',
    GLOW: 'rgba(57, 255, 20, 0.28)',
    LINE_WIDTH: 2,
    /** 低于此 RMS 视为静音，绘制静止中线 */
    SILENCE_THRESHOLD: 0.012,

    /**
     * 绘制以水平中线为基准的波形曲线
     * @param {CanvasRenderingContext2D} context
     * @param {number} width
     * @param {number} height
     * @param {Uint8Array} timeData - 时域数据（128 为零点）
     * @param {number} volume - 归一化音量 0–1
     */
    draw: function (context, width, height, timeData, volume) {
      if (!timeData || !timeData.length || width <= 0 || height <= 0) {
        return;
      }

      var centerY = height * 0.5;
      var ampScale = height * 0.42;
      var bufferLength = timeData.length;
      var sliceWidth = width / bufferLength;
      var isSilent = volume < this.SILENCE_THRESHOLD;

      context.strokeStyle = this.COLOR;
      context.lineWidth = this.LINE_WIDTH;
      context.lineJoin = 'round';
      context.lineCap = 'round';
      context.shadowColor = this.GLOW;
      context.shadowBlur = 8;

      context.beginPath();

      if (isSilent) {
        /* 静音：静止于中线 */
        context.moveTo(0, centerY);
        context.lineTo(width, centerY);
      } else {
        /* 发声：逐点映射 Y 轴偏移（0 向上，255 向下，128 为中线） */
        var x = 0;
        var i;
        for (i = 0; i < bufferLength; i++) {
          var y = centerY + ((timeData[i] - 128) / 128) * ampScale;
          if (i === 0) {
            context.moveTo(x, y);
          } else {
            context.lineTo(x, y);
          }
          x += sliceWidth;
        }
      }

      context.stroke();
      context.shadowBlur = 0;
    }
  };

  /* ==========================================================================
   * DOM 引用与应用状态
   * ========================================================================== */
  var mainCanvas = document.getElementById('mainCanvas');
  var canvasShell = document.getElementById('canvasShell');
  var pageLoader = document.getElementById('pageLoader');
  var canvasGuide = document.getElementById('canvasGuide');
  var browserCompat = document.getElementById('browserCompat');
  var statusBar = document.getElementById('statusBar');

  var btnStart = document.getElementById('btnStart');
  var btnStop = document.getElementById('btnStop');
  var btnClear = document.getElementById('btnClear');
  var btnSave = document.getElementById('btnSave');

  var ctx = mainCanvas.getContext('2d');
  var animationId = null;

  var state = {
    micAuthorized: false,
    isRunning: false,
    isRequesting: false,
    width: 0,
    height: 0
  };

  /* ==========================================================================
   * UI 工具
   * ========================================================================== */

  function setStatus(message, type) {
    statusBar.textContent = message;
    statusBar.className = 'status-bar';
    if (type) {
      statusBar.classList.add('is-' + type);
    }
  }

  /**
   * 按钮状态规则：
   * - 浏览器不支持：全部禁用
   * - 未授权：仅「开始涂鸦」可点（点击后发起授权），停止/清空/保存禁用
   * - 已授权且运行中：「停止」「清空」「保存」可点，「开始」禁用
   */
  function updateButtonStates() {
    var supported = BrowserSupport.isSupported;
    var authorized = state.micAuthorized;
    var running = state.isRunning;
    var busy = state.isRequesting;

    btnStart.disabled = !supported || busy || running;
    btnStop.disabled = !supported || !authorized || !running || busy;
    btnClear.disabled = !supported || !authorized || busy;
    btnSave.disabled = !supported || !authorized || busy;
  }

  function initBrowserCompat() {
    BrowserSupport.check();

    if (BrowserSupport.isSupported) {
      browserCompat.textContent = '当前浏览器受支持 · 推荐使用 Chrome / Edge 最新版';
      browserCompat.classList.remove('is-unsupported');
    } else {
      browserCompat.textContent = '当前浏览器不受支持，请使用 Chrome 或 Edge 最新版本打开';
      browserCompat.classList.add('is-unsupported');
      setStatus('浏览器不兼容：请使用 Chrome 或 Edge 打开本页面', 'error');
    }

    updateButtonStates();
  }

  /* ==========================================================================
   * Canvas
   * ========================================================================== */

  function resizeCanvas() {
    var rect = canvasShell.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    state.width = Math.floor(rect.width);
    state.height = Math.floor(rect.height);

    mainCanvas.width = Math.floor(state.width * dpr);
    mainCanvas.height = Math.floor(state.height * dpr);
    mainCanvas.style.width = state.width + 'px';
    mainCanvas.style.height = state.height + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCanvasBackground();

    if (state.isRunning) {
      renderFrame();
    }
  }

  function drawCanvasBackground() {
    var w = state.width;
    var h = state.height;
    if (w <= 0 || h <= 0) {
      return;
    }

    ctx.fillStyle = '#050810';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(57, 255, 20, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    var step = 40;
    var x;
    var y;
    for (x = step; x < w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (y = step; y < h; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  /**
   * 单帧渲染：背景 + 实时波形
   */
  function renderFrame() {
    var timeData = AudioEngine.getTimeDomainData();
    var volume = AudioEngine.getAverageVolume(timeData);

    drawCanvasBackground();
    WaveformRenderer.draw(ctx, state.width, state.height, timeData, volume);

    return volume;
  }

  var lastStatusUpdate = 0;

  function animationLoop(timestamp) {
    if (!state.isRunning) {
      return;
    }

    var now = timestamp || performance.now();
    var volume = renderFrame();

    /* 降低状态栏刷新频率，避免挤占绘制时间 */
    if (!lastStatusUpdate || now - lastStatusUpdate > 250) {
      lastStatusUpdate = now;
      var label = volume < WaveformRenderer.SILENCE_THRESHOLD ? '静音' : '发声';
      setStatus(
        '波形可视化中 · ' + label + ' · 音量 ' + (volume * 100).toFixed(0) + '%',
        'success'
      );
    }

    animationId = requestAnimationFrame(animationLoop);
  }

  function startAnimationLoop() {
    if (animationId) {
      cancelAnimationFrame(animationId);
    }
    lastStatusUpdate = 0;
    animationId = requestAnimationFrame(animationLoop);
  }

  function stopAnimationLoop() {
    if (animationId) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    lastStatusUpdate = 0;
    drawCanvasBackground();
  }

  /* ==========================================================================
   * 麦克风授权与启停
   * ========================================================================== */

  /**
   * 启动可视化主循环（需已完成麦克风授权）
   */
  function beginVisualization() {
    if (!AudioEngine.init()) {
      setStatus('音频引擎初始化失败，请刷新页面重试', 'error');
      return Promise.reject();
    }

    return AudioEngine._resumeContext().then(function () {
      state.isRunning = true;
      if (canvasGuide) {
        canvasGuide.classList.add('is-hidden');
      }
      updateButtonStates();
      startAnimationLoop();
    });
  }

  /**
   * 请求麦克风授权；成功后自动进入涂鸦状态
   */
  function authorizeAndStart() {
    if (!BrowserSupport.isSupported) {
      setStatus('请使用 Chrome 或 Edge 浏览器', 'error');
      return;
    }

    if (state.isRunning || state.isRequesting) {
      return;
    }

    state.isRequesting = true;
    updateButtonStates();
    setStatus('正在请求麦克风权限，请在浏览器弹窗中选择「允许」…', '');

    AudioEngine.requestMicrophone()
      .then(function () {
        state.micAuthorized = true;
        state.isRequesting = false;
        setStatus('麦克风授权成功，正在启动可视化…', 'success');
        return beginVisualization();
      })
      .catch(function (err) {
        state.isRequesting = false;
        state.isRunning = false;

        if (!state.micAuthorized) {
          setStatus(AudioEngine.getErrorMessage(err), 'error');
        } else {
          setStatus('授权成功但启动失败，请再次点击「开始涂鸦」重试', 'error');
        }
        updateButtonStates();
      });
  }

  /**
   * 停止涂鸦并释放麦克风
   */
  function stopDoodle() {
    state.isRunning = false;
    state.micAuthorized = false;
    stopAnimationLoop();
    AudioEngine.dispose();

    if (canvasGuide) {
      canvasGuide.classList.remove('is-hidden');
    }

    updateButtonStates();
    setStatus('已停止涂鸦，麦克风已关闭', '');
  }

  /* ==========================================================================
   * 控制栏事件
   * ========================================================================== */

  function bindControls() {
    btnStart.addEventListener('click', function () {
      if (!BrowserSupport.isSupported) {
        setStatus('请使用 Chrome 或 Edge 浏览器', 'error');
        return;
      }

      if (!state.micAuthorized) {
        authorizeAndStart();
        return;
      }

      if (!state.isRunning) {
        beginVisualization().catch(function () {
          setStatus('无法启动音频上下文，请重试', 'error');
        });
      }
    });

    btnStop.addEventListener('click', stopDoodle);

    btnClear.addEventListener('click', function () {
      if (state.isRunning) {
        renderFrame();
        setStatus('画布已刷新，波形继续实时显示', 'success');
      } else {
        drawCanvasBackground();
        setStatus('画布已清空', 'success');
      }
    });

    btnSave.addEventListener('click', function () {
      if (!state.micAuthorized) {
        setStatus('请先授权麦克风并开始涂鸦', 'warning');
        return;
      }
      setStatus('保存功能将在后续里程碑实现', 'warning');
    });
  }

  /* ==========================================================================
   * 初始化
   * ========================================================================== */

  function hidePageLoader() {
    pageLoader.classList.add('is-hidden');
    pageLoader.setAttribute('aria-busy', 'false');
  }

  function onPageReady() {
    resizeCanvas();
    hidePageLoader();

    if (BrowserSupport.isSupported) {
      setStatus('页面已就绪 · 点击「开始涂鸦」授权麦克风', '');
    }

    updateButtonStates();
  }

  function init() {
    initBrowserCompat();
    bindControls();
    window.addEventListener('resize', resizeCanvas);
    setStatus('正在加载声音涂鸦画板…', '');
    window.setTimeout(onPageReady, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* 暴露音频模块供调试（可选） */
  window.SoundDoodle = {
    AudioEngine: AudioEngine,
    WaveformRenderer: WaveformRenderer,
    BrowserSupport: BrowserSupport,
    getAverageVolume: function () {
      return AudioEngine.getAverageVolume();
    },
    getDominantFrequency: function () {
      return AudioEngine.getDominantFrequency();
    },
    getTimeDomainData: function () {
      return AudioEngine.getTimeDomainData();
    },
    getFrequencyData: function () {
      return AudioEngine.getFrequencyData();
    }
  };
})();
