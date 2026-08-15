/* ============================================================================
 * 屏码传 · 应用装配：模式切换、文件选择、按钮绑定、局域网提示
 * ==========================================================================*/
(function (global) {
  'use strict';

  var UI = {};
  var lastFile = null;
  function $(id) { return document.getElementById(id); }

  UI.toast = function (msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('show'); }, 2600);
  };

  function switchTab(mode) {
    $('tabSend').classList.toggle('active', mode === 'send');
    $('tabRecv').classList.toggle('active', mode === 'recv');
    $('panelSend').classList.toggle('active', mode === 'send');
    $('panelRecv').classList.toggle('active', mode === 'recv');
  }

  function onFile(file) {
    if (!file) return;
    if (file.size === 0) { UI.toast('空文件无法传输'); return; }
    if (file.size > 50 * 1024 * 1024) {
      UI.toast('文件较大（>50MB），传输将耗时较长，建议先压缩');
    }
    lastFile = file;
    var reader = new FileReader();
    reader.onload = function () {
      Sender.setFile(file.name, new Uint8Array(reader.result));
      showFileInfo(file);
      UI.toast('已载入：' + file.name);
    };
    reader.readAsArrayBuffer(file);
  }

  function showFileInfo(file) {
    var est = Sender.estimate();
    var tip = '';
    if (est) {
      tip = '码阵 ' + est.cols + '×' + est.rows + '（QR v' + est.version + '）· 每包约 ' + QRProtocol.fmtBytes(est.chunkSize) +
        ' · 共 ' + Math.ceil(file.size / est.chunkSize) + ' 包<br>' +
        '按典型效率估算：约 ' + QRProtocol.fmtTime(est.seconds) + '（实际取决于光线与手机性能）';
    }
    $('fileInfo').innerHTML = '<b>' + QRProtocol.esc(file.name) + '</b><br>' +
      QRProtocol.fmtBytes(file.size) + '<br><span class="dim">' + tip + '</span>';
  }

  function syncConfig() {
    Sender.setConfig($('speedSel').value, $('colorSyncChk').checked, $('fullscreenChk').checked);
    if (lastFile) showFileInfo(lastFile);
  }

  /* ---------- 标签页 ---------- */
  $('tabSend').addEventListener('click', function () { switchTab('send'); });
  $('tabRecv').addEventListener('click', function () { switchTab('recv'); });

  /* ---------- 文件选择（点击 / 拖拽） ---------- */
  var dz = $('dropZone');
  dz.addEventListener('click', function () { $('fileInput').click(); });
  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
  });
  dz.addEventListener('drop', function (e) {
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) onFile(f);
  });
  $('fileInput').addEventListener('change', function (e) {
    if (e.target.files && e.target.files[0]) onFile(e.target.files[0]);
  });
  $('speedSel').addEventListener('change', syncConfig);
  $('colorSyncChk').addEventListener('change', syncConfig);
  $('fullscreenChk').addEventListener('change', syncConfig);

  /* ---------- 发送控制 ---------- */
  $('btnStart').addEventListener('click', function () {
    if (Sender.isRunning()) return;
    syncConfig();
    Sender.start();
  });
  $('btnStop').addEventListener('click', function () { Sender.stop(); });
  $('btnAlign').addEventListener('click', function () {
    syncConfig();
    Sender.align();
  });
  $('txStop').addEventListener('click', function () { Sender.stop(); });

  /* ---------- 接收控制 ---------- */
  $('btnCam').addEventListener('click', function () {
    var btn = $('btnCam');
    if (Receiver.isRunning()) {
      Receiver.stop();
      btn.textContent = '📷 开启摄像头';
    } else {
      btn.textContent = '⏹ 关闭摄像头';
      Receiver.start().then(function () {
        if (!Receiver.isRunning()) btn.textContent = '📷 开启摄像头';
      });
    }
  });
  $('btnDownload').addEventListener('click', function () { Receiver.download(); });
  $('btnRelocate').addEventListener('click', function () { Receiver.relocate(); });

  /* ---------- 尺寸变化 ---------- */
  window.addEventListener('resize', function () { Sender.onResize(); });

  /* ---------- 局域网提示横幅 ---------- */
  (function initBanner() {
    var b = $('banner');
    if (!b) return;
    var proto = location.protocol;
    if (proto === 'http:' || proto === 'https:') {
      var host = location.hostname;
      if (host !== '127.0.0.1' && host !== 'localhost') {
        b.innerHTML = '📱 手机与本机连同一 Wi-Fi 时，在手机浏览器打开：<b>' + QRProtocol.esc(location.href) + '</b>（保持本页开启）';
      } else {
        b.innerHTML = '📱 用电脑运行「启动局域网服务.bat」后，在手机浏览器访问电脑的局域网地址（Android 也可直接把本文件发给手机，用浏览器打开）';
      }
      b.style.display = 'block';
    } else {
      b.innerHTML = '📱 Android Chrome/Edge 可直接用浏览器打开本文件并调用摄像头；iOS 建议用局域网服务方式访问';
      b.style.display = 'block';
    }
    b.addEventListener('click', function () { b.style.display = 'none'; });
  })();

  /* ---------- 页面关闭时清理 ---------- */
  window.addEventListener('beforeunload', function () {
    try { Sender.stop(); Receiver.stop(); } catch (e) {}
  });

  global.UI = UI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
