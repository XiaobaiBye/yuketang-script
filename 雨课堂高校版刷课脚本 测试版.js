// ==UserScript==
// @name                      雨课堂高校版刷课脚本（测试版）
// @namespace                 http://tampermonkey.net/swu-test/
// @version                   1.0-test.6
// @description               SWU 测试通道：用于验证字体解密等新功能，请勿与正式版同时启用
// @author                    XiaobaiBye
// @license                   GPL3
// @match                     *://*.yuketang.cn/*
// @match                     *://*.gdufemooc.cn/*
// @run-at                    document-start
// @icon                      http://yuketang.cn/favicon.ico
// @grant                     unsafeWindow
// @grant                     GM_xmlhttpRequest
// @grant                     GM_registerMenuCommand
// @grant                     GM_unregisterMenuCommand
// @grant                     GM_getValue
// @grant                     GM_setValue
// @connect                   api.openai.com
// @connect                   api.moonshot.cn
// @connect                   api.deepseek.com
// @connect                   dashscope.aliyuncs.com
// @connect                   api.anthropic.com
// @connect                   platform.itihey.com
// @connect                   *
// @connect                   cdn.jsdelivr.net
// @connect                   unpkg.com
// @require                   https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js
// @require                   https://raw.githubusercontent.com/novob/yuketang-deobfuscator/eff23eebba1221555d19d10e65a47cd2cd412da5/yuketang-deobfuscator.user.js
// @require                   https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require                   https://unpkg.com/tesseract.js@v2.1.0/dist/tesseract.min.js
// @website                   https://soujiaoben.org/#/s?id=3030&host=scriptcat
// ==/UserScript==



(() => {
  'use strict';

  let panel; // UI 面板实例后置初始化

  // ---- 脚本配置，用户可修改 ----
  const Config = {
    version: '1.0-test.6', // 测试版版本号
    playbackRate: 2,      // 视频播放倍速
    pptInterval: 3000,    // ppt翻页间隔
    storageKeys: {        // 使用者勿动
      progress: '[雨课堂SWU测试版]刷课进度信息',
      ai: 'ykt_swu_test_ai_conf',
      questionBank: 'ykt_swu_test_question_bank_conf',
      proClassCount: 'ykt_swu_test_pro_lms_classCount',
      feature: 'ykt_swu_test_feature_conf', // 是否开启AI作答/自动评论
      pendingAutoStart: 'ykt_swu_test_pending_auto_start',
      answerSources: 'ykt_swu_test_answer_sources',
      mediaPlayback: 'ykt_swu_test_media_playback'
    }
  };

  const Utils = {
    // 短暂睡眠，等待网页加载
    sleep: (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms)),
    // 将一个 JSON 字符串解析为 JavaScript 对象
    safeJSONParse(value, fallback) {
      try {
        return JSON.parse(value);
      } catch (_) {
        return fallback;
      }
    },
    // 每隔一段时间检查某个条件是否满足（通过 checker 函数），如果满足就成功返回；如果超时仍未满足，就失败返回
    poll(checker, { interval = 1000, timeout = 20000 } = {}) {
      return new Promise(resolve => {
        const start = Date.now();
        const timer = setInterval(() => {
          if (checker()) {
            clearInterval(timer);
            resolve(true);
            return;
          }
          if (Date.now() - start > timeout) {
            clearInterval(timer);
            resolve(false);
          }
        }, interval);
      });
    },
    // 使用UI课程完成度来判别是否完成课程
    isProgressDone(text) {
      if (!text) return false;
      const percentages = [...String(text).matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)]
        .map(match => Number(match[1]))
        .filter(value => Number.isFinite(value) && value >= 0 && value <= 100);
      if (percentages.length) return Math.max(...percentages) === 100;
      return text.includes('已完成');
    },
    // 主要是规避firefox会创建多个iframe的问题
    inIframe() {
      return window.top !== window.self;
    },
    // 下滑到最底部，触发课程加载
    scrollToBottom(containerSelector) {
      const el = document.querySelector(containerSelector);
      if (el) el.scrollTop = el.scrollHeight;
    },
    getCurrentClassroomId() {
      const query = new URLSearchParams(location.search);
      const queryId = query.get('classroom_id');
      if (queryId) return queryId;

      const path = location.pathname;
      return path.match(/^\/ai-workspace\/lms-graph\/([^/]+)/)?.[1]
        || path.match(/^\/v2\/web\/studentLog\/([^/]+)/)?.[1]
        || path.match(/\/(\d+)\/studycontent$/)?.[1]
        || '';
    },
    returnUrl() { // 得到课程开始的url
      if (location.pathname.includes('/v2/web/studentLog/') || location.pathname.includes('pro/lms/')) {
        return location.href
      }
      return ""
    },
    isSupportedLearningPage() {
      const path = location.pathname;
      return path.includes('/ai-workspace/lms-graph/')
        || path.includes('/v2/web/')
        || path.includes('/pro/lms/');
    },
    waitForMountTarget(timeout = 15000) {
      const getTarget = () => document.body || document.documentElement;
      const existing = getTarget();
      if (existing) return Promise.resolve(existing);

      return new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(getTarget());
        };
        const observer = new MutationObserver(() => {
          if (getTarget()) finish();
        });
        observer.observe(document, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', finish, { once: true });
        window.addEventListener('load', finish, { once: true });
        const timer = setTimeout(finish, timeout);
      });
    },
    async getDDL(targetMedia = null) {
      const element = targetMedia || document.querySelector('video') || document.querySelector('audio');

      const fallback = 180_000;
      if (!element) return fallback;

      let duration = Number(element.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        await Utils.poll(() => {
          const value = Number(element.duration);
          return Number.isFinite(value) && value > 0;
        }, { interval: 200, timeout: 5000 });
        duration = Number(element.duration);
      }
      if (!Number.isFinite(duration) || duration <= 0) return fallback;

      const elementDurationMs = duration * 1000;               // 转为秒
      const timeout = Math.max(elementDurationMs * 3, 10_000); // 至少 10 秒（防极短视频）;
      return timeout;
    },
    // 关闭雨课堂的挂机/离开检测弹窗，避免遮罩拦截刷课流程
    dismissPopups() {
      const wrappers = document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper');
      for (const wrapper of wrappers) {
        const style = getComputedStyle(wrapper);
        const rect = wrapper.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) continue;
        const text = wrapper.innerText || '';
        const buttons = [...wrapper.querySelectorAll('button')];
        const clickBtn = label => {
          const btn = buttons.find(b => (b.innerText || '').trim().includes(label));
          if (btn) btn.click();
        };
        if (text.includes('好好学习') || text.includes('继续观看')) {
          clickBtn('继续观看');
        } else if (text.includes('报告老师')) {
          clickBtn('取消');
        }
      }
    }
  };

  // ---- 存储工具 ----
  const Store = {
    getProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {}) || { url: { outside: 0, inside: 0 } };
      if (!all[url]) {
        all[url] = { outside: 0, inside: 0 };
        localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
      }
      return { all, current: all[url] };
    },
    setProgress(url, outside, inside = 0) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      all[url] = { outside, inside };
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    removeProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      delete all[url];
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    getAIConf() {
      const raw = localStorage.getItem(Config.storageKeys.ai);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        url: saved.url ?? "https://api.deepseek.com/chat/completions",
        key: saved.key ?? "sk-xxxxxxx",
        model: saved.model ?? "deepseek-chat",
        apiFormat: saved.apiFormat ?? "openai", // openai 或 anthropic
        authMethod: saved.authMethod ?? "bearer", // bearer 或 x-api-key
      };
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
      return conf;
    },
    setAIConf(conf) {
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
    },
    getQuestionBankConf() {
      const raw = localStorage.getItem(Config.storageKeys.questionBank);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        enabled: saved.enabled ?? false,
        url: saved.url ?? 'https://platform.itihey.com/v1/search',
        key: saved.key ?? '',
      };
      localStorage.setItem(Config.storageKeys.questionBank, JSON.stringify(conf));
      return conf;
    },
    setQuestionBankConf(conf) {
      localStorage.setItem(Config.storageKeys.questionBank, JSON.stringify(conf));
    },
    getProClassCount() {
      const value = localStorage.getItem(Config.storageKeys.proClassCount);
      return value ? Number(value) : 1;
    },
    setProClassCount(count) {
      localStorage.setItem(Config.storageKeys.proClassCount, count);
    },
    getFeatureConf() {
      const raw = localStorage.getItem(Config.storageKeys.feature);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        autoAI: saved.autoAI ?? false,
        autoComment: saved.autoComment ?? false,
        answerSubmitMode: saved.answerSubmitMode ?? 'save', // auto 或 save
        saveOnlyAction: saved.saveOnlyAction ?? 'manual', // next 或 manual
      };
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
      return conf;
    },
    setFeatureConf(conf) {
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
    },
    getPendingAutoStart() {
      const raw = localStorage.getItem(Config.storageKeys.pendingAutoStart);
      const saved = Utils.safeJSONParse(raw, null);
      if (!saved || !saved.classroomId || !saved.ts) return null;
      if (Date.now() - saved.ts > 30 * 60 * 1000) {
        localStorage.removeItem(Config.storageKeys.pendingAutoStart);
        return null;
      }
      return saved;
    },
    setPendingAutoStart(classroomId = '', returnUrl = '') {
      if (!classroomId) return;
      const prev = this.getPendingAutoStart() || {};
      localStorage.setItem(Config.storageKeys.pendingAutoStart, JSON.stringify({
        classroomId,
        returnUrl: returnUrl || prev.returnUrl || '',
        ts: Date.now()
      }));
    },
    clearPendingAutoStart() {
      localStorage.removeItem(Config.storageKeys.pendingAutoStart);
    },
    getMediaPlayback() {
      const saved = Utils.safeJSONParse(localStorage.getItem(Config.storageKeys.mediaPlayback), {}) || {};
      return {
        current: saved.current || null,
        history: Array.isArray(saved.history) ? saved.history.slice(0, 10) : []
      };
    },
    setCurrentMediaPlayback(record) {
      const saved = this.getMediaPlayback();
      saved.current = record || null;
      localStorage.setItem(Config.storageKeys.mediaPlayback, JSON.stringify(saved));
    },
    archiveMediaPlayback(record) {
      if (!record) return;
      const saved = this.getMediaPlayback();
      saved.current = record;
      saved.history.unshift(JSON.parse(JSON.stringify(record)));
      saved.history = saved.history.slice(0, 10);
      localStorage.setItem(Config.storageKeys.mediaPlayback, JSON.stringify(saved));
    },
    getAnswerSources(scope) {
      const all = Utils.safeJSONParse(localStorage.getItem(Config.storageKeys.answerSources), {}) || {};
      return all[scope] || {};
    },
    setAnswerSource(scope, questionNumber, source) {
      if (!scope || !questionNumber || !source) return;
      const all = Utils.safeJSONParse(localStorage.getItem(Config.storageKeys.answerSources), {}) || {};
      all[scope] = all[scope] || {};
      all[scope][questionNumber] = { source, updatedAt: Date.now() };
      const scopes = Object.keys(all).sort((a, b) => {
        const newest = value => Math.max(0, ...Object.values(value || {}).map(item => Number(item?.updatedAt || 0)));
        return newest(all[b]) - newest(all[a]);
      });
      scopes.slice(30).forEach(key => delete all[key]);
      localStorage.setItem(Config.storageKeys.answerSources, JSON.stringify(all));
    },
    clearAnswerSources(scope) {
      const all = Utils.safeJSONParse(localStorage.getItem(Config.storageKeys.answerSources), {}) || {};
      delete all[scope];
      localStorage.setItem(Config.storageKeys.answerSources, JSON.stringify(all));
    },
    trimAnswerSources(scope, maxQuestionNumber) {
      if (!scope || !maxQuestionNumber) return;
      const all = Utils.safeJSONParse(localStorage.getItem(Config.storageKeys.answerSources), {}) || {};
      const records = all[scope];
      if (!records) return;
      Object.keys(records).forEach(numberText => {
        if (Number(numberText) > maxQuestionNumber) delete records[numberText];
      });
      localStorage.setItem(Config.storageKeys.answerSources, JSON.stringify(all));
    },
  };

  // ---- UI 面板 ----
  function createPanel() {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '40px';
    iframe.style.left = '40px';
    iframe.style.width = '520px';
    iframe.style.height = '340px';
    iframe.style.zIndex = '999999';
    iframe.style.border = '1px solid #a3a3a3';
    iframe.style.borderRadius = '10px';
    iframe.style.background = '#fff';
    iframe.style.overflow = 'hidden';
    iframe.style.boxShadow = '6px 4px 17px 2px #000000';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('id', 'ykt-helper-iframe');
    iframe.setAttribute('allowtransparency', 'true');
    const mountTarget = document.body || document.documentElement;
    if (!mountTarget) {
      throw new Error('面板挂载点不存在');
    }
    mountTarget.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`
                  <style>
              /* 全局重置 */
              html, body { overflow: hidden; margin: 0; padding: 0; font-family: "Segoe UI", "PingFang SC", Avenir, Helvetica, Arial, sans-serif; color: #4a4a4a; background: transparent; }

              /* 主容器 */
              .mini-basic {
                position: absolute;
                inset: 0;
                background: #3a7afe;
                color: white;
                height: 100%;
                width: 100%;
                min-height: 42px;
                min-width: 42px;
                border-radius: 10px;
                text-align: center;
                line-height: 1;
                z-index: 1000000;
                cursor: pointer;
                display: none;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                box-shadow: 0 4px 12px rgba(0,0,0,0);
              }
              .mini-basic.show {
                display: flex;
              }

              /* 面板主容器 */
              .panel {
                width: 100%;
                height: 100%;
                background: white;
                border-radius: 10px;
                position: relative;
                overflow: hidden;
              }

              /* 标题栏 */
              .header {
                text-align: center;
                height: 40px;
                background: #f7f7f7;
                color: #000;
                font-size: 18px;
                line-height: 40px;
                border-radius: 10px 10px 0 0;
                border-bottom: 2px solid #eee;
                cursor: move;
                position: relative;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 10px;
              }
              .tools ul {
                margin: 0;
                padding: 0;
                list-style: none;
                display: flex;
                gap: 5px;
              }
              .tools li {
                display: inline-block;
                cursor: pointer;
                font-size: 14px;
                padding: 0 5px;
              }

              /* 内容区 */
              .body {
                font-weight: normal;
                font-size: 13px;
                line-height: 22px;
                height: calc(100% - 85px);
                overflow-y: auto;
                padding: 6px 8px;
                box-sizing: border-box;
              }

              .info {
                margin: 0;
                padding: 0;
                list-style: none;
              }
              .info li {
                margin-bottom: 4px;
                color: #333;
              }

              /* 设置面板 */
              #settings {
                display: none;
                position: absolute;
                top: 40px;
                left: 0;
                width: 100%;
                height: calc(100% - 40px);
                background: white;
                z-index: 99;
                padding: 15px;
                box-sizing: border-box;
                overflow-y: auto;
              }

              /* 表单项 */
              .form-item {
                margin-bottom: 15px;
              }
              .form-item label {
                display: block;
                margin-bottom: 5px;
                font-size: 12px;
                color: #333;
              }
              .form-item input[type="text"],
              .form-item input[type="password"] {
                width: 100%;
                padding: 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                font-size: 12px;
                box-sizing: border-box;
              }

              /* 复选框标签优化：避免“启用”跑到右边 */
              .form-item .checkbox-label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                cursor: pointer;
              }
              .form-item .checkbox-label input[type="checkbox"] {
                margin: 0;
                width: auto;
              }

              /* 底部按钮栏 */
              .footer {
                position: absolute;
                bottom: 0;
                left: 0;
                width: 100%;
                background: #f7f7f7;
                color: #c5c5c5;
                font-size: 13px;
                line-height: 25px;
                border-radius: 0 0 10px 10px;
                border-bottom: 2px solid #eee;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 6px 0;
                gap: 10px;
              }
              .footer button {
                border: none;
                border-radius: 6px;
                color: white;
                cursor: pointer;
                padding: 6px 12px;
                font-size: 12px;
                transition: all 0.2s ease;
              }
              #btn-start {
                background-color: #1677ff;
              }
              #btn-start:hover {
                background-color: #f6ff00;
                color: black;
              }
              #btn-clear {
                background-color: #ff4d4f;
              }
              #btn-setting {
                background-color: #52c41a;
              }
              #btn-stop {
                background-color: #8c8c8c;
              }
              #btn-reload {
                background-color: #fa8c16;
              }
              #btn-diagnostic {
                background-color: #722ed1;
              }

              /* 设置页底部按钮 */
              .settings-footer {
                text-align: center;
                margin-top: 12px;
                display: flex;
                justify-content: center;
                gap: 10px;
              }
              .settings-footer button {
                padding: 6px 15px;
                font-size: 12px;
                border-radius: 6px;
                border: none;
                cursor: pointer;
              }
              #save_settings {
                background-color: #1677ff;
                color: white;
              }
              #close_settings {
                background-color: #999;
                color: white;
              }
            </style>

            <div class="mini-basic" id="mini-basic">展开</div>
            <div class="panel" id="panel">
              <div class="header" id="header">
                🧪 雨课堂高校版刷课脚本（测试版）
                <div class='tools'>
                  <ul>
                    <li class='minimality' id="minimality">_</li>
                    <li class='question' id="question">?</li>
                  </ul>
                </div>
              </div>
              <div class="body">
                <ul class="info" id="info">
                  <li style="color:#722ed1;font-weight:700;">🧪 当前为测试版，请先关闭油猴中的正式版脚本</li>
                  <li>🔓 <strong>实验功能：</strong>检测到雨课堂加密字体时先在浏览器内还原，失败再回退 OCR</li>
                  <li>⭐ 脚本支持：雨课堂所有版本</li>
                  <li>🤖 <strong>支持模型：</strong>DeepSeek、Kimi(Moonshot)、通义千问、OpenAI、Claude(Anthropic)</li>
                  <li>📢 <strong>使用必读：</strong>自动答题需先点击<span style="color:green">[AI配置]</span>开启，并填写题库或 AI 的 API Key</li>
                  <li>🚀 配置完成后，点击<span style="color:blue">[开始刷课]</span>即可启动视频与作业挂机</li>
                  <li>🤝 脚本还有很多不足，欢迎各位一起完善代码</li>
                  <hr>
                </ul>
              </div>
              <div id="settings">
                <div class="form-item">
                  <label>API URL:</label>
                  <input type="text" id="ai_url" placeholder="https://api.deepseek.com/chat/completions">
                </div>
                <div class="form-item">
                  <label>API KEY:</label>
                  <input type="password" id="ai_key" placeholder="sk-xxxxxxxx">
                </div>
                <div class="form-item">
                  <label>Model Name:</label>
                  <input type="text" id="ai_model" placeholder="deepseek-chat">
                </div>
                <div class="form-item">
                  <label>API Format:</label>
                  <select id="ai_format" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                    <option value="openai">OpenAI Format (Chat Completions)</option>
                    <option value="anthropic">Anthropic Format (Messages API)</option>
                  </select>
                </div>
                <div class="form-item">
                  <label>Auth Method:</label>
                  <select id="auth_method" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                    <option value="bearer">Bearer Token (Authorization: Bearer)</option>
                    <option value="x-api-key">X-API-Key Header</option>
                  </select>
                </div>
                <hr style="border:0;border-top:1px solid #eee;margin:16px 0;">
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="question_bank_enabled">
                    启用 ITIHEY 题库
                  </label>
                </div>
                <div class="form-item">
                  <label>ITIHEY API URL:</label>
                  <input type="text" id="question_bank_url" placeholder="https://platform.itihey.com/v1/search">
                </div>
                <div class="form-item">
                  <label>ITIHEY API KEY:</label>
                  <input type="password" id="question_bank_key" placeholder="itk_xxxxxxxxx">
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_auto_ai">
                    启用 AI 答题（题库失败时兜底）
                  </label>
                </div>
                <div class="form-item">
                  <label>答案提交方式:</label>
                  <select id="answer_submit_mode" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                    <option value="auto">自动提交答案</option>
                    <option value="save">只保存答案（只勾选，不提交）</option>
                  </select>
                </div>
                <div class="form-item" id="save_only_action_wrap">
                  <label>只保存答案后:</label>
                  <select id="save_only_action" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                    <option value="next">自动进入下一个课程</option>
                    <option value="manual">答完整章后停留，由我手动提交</option>
                  </select>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_auto_comment">
                    用批量区图文/讨论自动回复
                  </label>
                </div>
                <div class="settings-footer">
                  <button id="save_settings">保存并关闭</button>
                  <button id="close_settings">取消</button>
                </div>
              </div>
              <div class="footer">
                <button id="btn-setting">AI配置</button>
                <button id="btn-clear">清除缓存</button>
                <button id="btn-start">开始刷课</button>
                <button id="btn-stop">停止刷课</button>
                <button id="btn-reload">重新加载</button>
                <button id="btn-diagnostic">导出诊断</button>
              </div>
            </div>
    `);
    doc.close();

    const ui = {
      iframe,
      doc,
      panel: doc.getElementById('panel'),
      header: doc.getElementById('header'),
      info: doc.getElementById('info'),
      btnStart: doc.getElementById('btn-start'),
      btnClear: doc.getElementById('btn-clear'),
      btnSetting: doc.getElementById('btn-setting'),
      btnStop: doc.getElementById('btn-stop'),
      btnReload: doc.getElementById('btn-reload'),
      btnDiagnostic: doc.getElementById('btn-diagnostic'),
      settings: doc.getElementById('settings'),
      saveSettings: doc.getElementById('save_settings'),
      closeSettings: doc.getElementById('close_settings'),
      aiUrlInput: doc.getElementById('ai_url'),
      aiKeyInput: doc.getElementById('ai_key'),
      aiModelInput: doc.getElementById('ai_model'),
      aiFormatSelect: doc.getElementById('ai_format'),
      authMethodSelect: doc.getElementById('auth_method'),
      questionBankEnabled: doc.getElementById('question_bank_enabled'),
      questionBankUrl: doc.getElementById('question_bank_url'),
      questionBankKey: doc.getElementById('question_bank_key'),
      featureAutoAI: doc.getElementById('feature_auto_ai'),
      answerSubmitMode: doc.getElementById('answer_submit_mode'),
      saveOnlyAction: doc.getElementById('save_only_action'),
      saveOnlyActionWrap: doc.getElementById('save_only_action_wrap'),
      featureAutoComment: doc.getElementById('feature_auto_comment'),
      minimality: doc.getElementById('minimality'),
      question: doc.getElementById('question'),
      miniBasic: doc.getElementById('mini-basic')
    };

    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const hostWindow = window.parent || window;
    const onMove = e => {
      if (!isDragging) return;
      const deltaX = e.screenX - startX;
      const deltaY = e.screenY - startY;
      const maxLeft = Math.max(0, hostWindow.innerWidth - iframe.offsetWidth);
      const maxTop = Math.max(0, hostWindow.innerHeight - iframe.offsetHeight);
      iframe.style.left = Math.min(Math.max(0, startLeft + deltaX), maxLeft) + 'px';
      iframe.style.top = Math.min(Math.max(0, startTop + deltaY), maxTop) + 'px';
    };
    const stopDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      iframe.style.transition = '';
      doc.body.style.userSelect = '';
    };
    ui.header.addEventListener('mousedown', e => {
      isDragging = true;
      startX = e.screenX;
      startY = e.screenY;
      startLeft = parseFloat(iframe.style.left) || 0;
      startTop = parseFloat(iframe.style.top) || 0;
      iframe.style.transition = 'none';
      doc.body.style.userSelect = 'none';
      e.preventDefault();
    });
    doc.addEventListener('mousemove', onMove);
    hostWindow.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('blur', stopDrag);

    const normalSize = { width: parseFloat(iframe.style.width), height: parseFloat(iframe.style.height) };
    const miniSize = 64;
    let isMinimized = false;
    const enterMini = () => {
      if (isMinimized) return;
      isMinimized = true;
      ui.panel.style.display = 'none';
      ui.miniBasic.classList.add('show');
      iframe.style.width = miniSize + 'px';
      iframe.style.height = miniSize + 'px';
    };
    const exitMini = () => {
      if (!isMinimized) return;
      isMinimized = false;
      ui.panel.style.display = '';
      ui.miniBasic.classList.remove('show');
      iframe.style.width = normalSize.width + 'px';
      iframe.style.height = normalSize.height + 'px';
    };
    ui.minimality.addEventListener('click', enterMini);
    ui.miniBasic.addEventListener('click', exitMini);

    ui.question.addEventListener('click', () => {
      window.parent.alert('作者：niuwh.cn（重构版 by Codex）');
    });

    const log = message => {
      const li = doc.createElement('li');
      li.innerText = message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const warn = message => {
      const li = doc.createElement('li');
      li.innerText = '⚠️警告：' + message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const error = message => {
      const li = doc.createElement('li');
      li.innerText = '🚨报错：' + message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const defaultAI = { url: 'https://api.deepseek.com/chat/completions', key: 'sk-xxxxxxx', model: 'deepseek-chat', apiFormat: 'openai', authMethod: 'bearer' };
    const loadAIConf = () => {
      const saved = Store.getAIConf();
      ui.aiUrlInput.value = saved.url || defaultAI.url;
      ui.aiKeyInput.value = saved.key || defaultAI.key;
      ui.aiModelInput.value = saved.model || defaultAI.model;
      ui.aiFormatSelect.value = saved.apiFormat || defaultAI.apiFormat;
      ui.authMethodSelect.value = saved.authMethod || defaultAI.authMethod;
    };
    const loadFeatureConf = () => {
      const saved = Store.getFeatureConf();
      ui.featureAutoAI.checked = saved.autoAI;
      ui.featureAutoComment.checked = saved.autoComment;
      ui.answerSubmitMode.value = saved.answerSubmitMode;
      ui.saveOnlyAction.value = saved.saveOnlyAction;
      ui.saveOnlyActionWrap.style.display = saved.answerSubmitMode === 'save' ? '' : 'none';
    };
    const loadQuestionBankConf = () => {
      const saved = Store.getQuestionBankConf();
      ui.questionBankEnabled.checked = saved.enabled;
      ui.questionBankUrl.value = saved.url;
      ui.questionBankKey.value = saved.key;
    };
    loadAIConf();
    loadFeatureConf();
    loadQuestionBankConf();
    ui.btnSetting.onclick = () => {
      loadAIConf();
      loadFeatureConf();
      loadQuestionBankConf();
      ui.settings.style.display = 'block';
    };
    ui.closeSettings.onclick = () => {
      ui.settings.style.display = 'none';
    };
    ui.answerSubmitMode.onchange = () => {
      ui.saveOnlyActionWrap.style.display = ui.answerSubmitMode.value === 'save' ? '' : 'none';
    };
    ui.saveSettings.onclick = () => {
      if (!ui.questionBankEnabled.checked && !ui.featureAutoAI.checked) {
        warn('请选择答题方式');
        window.parent.alert('请选择答题方式');
        return;
      }
      const conf = {
        url: ui.aiUrlInput.value.trim(),
        key: ui.aiKeyInput.value.trim(),
        model: ui.aiModelInput.value.trim(),
        apiFormat: ui.aiFormatSelect.value,
        authMethod: ui.authMethodSelect.value
      };
      Store.setAIConf(conf);
      Store.setQuestionBankConf({
        enabled: ui.questionBankEnabled.checked,
        url: ui.questionBankUrl.value.trim() || 'https://platform.itihey.com/v1/search',
        key: ui.questionBankKey.value.trim()
      });
      const featureConf = {
        autoAI: ui.featureAutoAI.checked,
        autoComment: ui.featureAutoComment.checked,
        answerSubmitMode: ui.answerSubmitMode.value,
        saveOnlyAction: ui.saveOnlyAction.value
      };
      Store.setFeatureConf(featureConf);
      ui.settings.style.display = 'none';
      log('✅ 答题配置已保存');
    };

    ui.btnClear.onclick = () => {
      Store.removeProgress(window.parent.location.href);
      localStorage.removeItem(Config.storageKeys.proClassCount);
      Store.clearPendingAutoStart();
      log('已清除当前课程的刷课进度缓存');
    };

    // 停止刷课：清除自动恢复标记后刷新页面，刷新后脚本回到空闲状态（进度缓存保留）
    ui.btnStop.onclick = () => {
      Store.clearPendingAutoStart();
      log('已停止刷课，页面即将刷新');
      window.parent.location.reload();
    };

    // 重新加载：重建自动恢复标记后刷新页面，刷新后自动恢复刷课（停止后点击同样生效）
    ui.btnReload.onclick = () => {
      Store.setPendingAutoStart(Utils.getCurrentClassroomId());
      log('正在重新加载脚本...');
      window.parent.location.reload();
    };

    ui.btnDiagnostic.onclick = () => {
      try {
        exportDiagnostics(ui);
      } catch (err) {
        error(`导出诊断失败：${err.message || err}`);
      }
    };

    let startHandler = null;
    let running = false;
    const invokeStart = async () => {
      if (running) {
        log('已在刷课中，忽略重复启动');
        return;
      }
      running = true;
      log('启动中...');
      ui.btnStart.innerText = '刷课中...';
      try {
        if (startHandler) await startHandler();
      } catch (err) {
        error(`运行失败：${err.message || err}`);
        console.error('[雨课堂定制版] 运行失败', err);
      } finally {
        running = false;
        if (ui.btnStart.innerText === '刷课中...') ui.btnStart.innerText = '继续运行';
      }
    };

    // 后面赋值给panel
    return {
      ...ui,
      log,
      warn,
      error,
      setStartHandler(fn) {
        startHandler = fn;
        ui.btnStart.onclick = invokeStart;
      },
      start() {
        invokeStart();
      },
      resetStartButton(text = '开始刷课') {
        ui.btnStart.innerText = text;
        if (text !== '刷课中...') running = false;
      }
    };
  }

  // ---- 播放器工具 ----
  const Player = {
    isNearEnd(media, threshold = 1) {
      if (!media) return false;
      const duration = Number(media.duration || 0);
      const currentTime = Number(media.currentTime || 0);
      return Number.isFinite(duration) && duration > 1 && currentTime > 0 && duration - currentTime <= threshold;
    },
    applySpeed() {
      const rate = Config.playbackRate;
      const speedBtn = document.querySelector('xt-speedlist xt-button') || document.getElementsByTagName('xt-speedlist')[0]?.firstElementChild?.firstElementChild;
      const speedWrap = document.getElementsByTagName('xt-speedbutton')[0];
      if (speedBtn && speedWrap) {
        speedBtn.setAttribute('data-speed', rate);
        speedBtn.setAttribute('keyt', `${rate}.00`);
        speedBtn.innerText = `${rate}.00X`;
        const mousemove = document.createEvent('MouseEvent');
        mousemove.initMouseEvent('mousemove', true, true, unsafeWindow, 0, 10, 10, 10, 10, 0, 0, 0, 0, 0, null);
        speedWrap.dispatchEvent(mousemove);
        speedBtn.click();
      } else if (document.querySelector('video')) {
        document.querySelector('video').playbackRate = rate;
      }
    },
    mute() {
      const muteBtn = document.querySelector('#video-box > div > xt-wrap > xt-controls > xt-inner > xt-volumebutton > xt-icon');
      if (muteBtn) muteBtn.click();
      const video = document.querySelector('video');
      if (video) video.volume = 0;
    },
    applyMediaDefault(media) {
      if (!media) return;
      media.play();
      media.volume = 0;
      media.playbackRate = Config.playbackRate;
    },
    async rewindToStart(media, maxAttempts = 3) {
      if (!media) return { success: false, reason: 'media-not-found', attempts: 0 };
      const metadataReady = await Utils.poll(() => {
        const duration = Number(media.duration || 0);
        return media.isConnected && media.readyState >= 1 && Number.isFinite(duration) && duration > 0;
      }, { interval: 200, timeout: 8000 });
      if (!metadataReady) {
        return {
          success: false,
          reason: 'metadata-not-ready',
          attempts: 0,
          currentTime: Number(media.currentTime || 0)
        };
      }

      const originalTime = Number(media.currentTime || 0);
      let lastError = '';
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          media.pause();
          media.currentTime = 0;
        } catch (err) {
          lastError = String(err?.message || err);
          await Utils.sleep(300);
          continue;
        }
        const reset = await Utils.poll(
          () => Number(media.currentTime || 0) <= 0.35,
          { interval: 100, timeout: 2500 }
        );
        if (!reset) continue;

        // 给雨课堂自己的“恢复上次位置”逻辑留出执行时间；若又跳回旧位置则重试。
        await Utils.sleep(1000);
        if (Number(media.currentTime || 0) > 2.5) continue;
        try {
          media.pause();
          media.currentTime = 0;
        } catch (_) { }
        await Utils.sleep(120);
        return {
          success: Number(media.currentTime || 0) <= 0.5,
          reason: 'rewound-to-start',
          attempts: attempt,
          originalTime,
          currentTime: Number(media.currentTime || 0)
        };
      }
      return {
        success: false,
        reason: lastError ? `rewind-failed: ${lastError}` : 'resume-position-restored-repeatedly',
        attempts: maxAttempts,
        originalTime,
        currentTime: Number(media.currentTime || 0)
      };
    },
    observePause(video, shouldResume = () => true) {
      if (!video) return () => { };
      const canResume = () => shouldResume() && !video.ended && !this.isNearEnd(video);
      // 自动播放
      const playVideo = () => {
        if (!canResume()) return;
        video.play().catch(e => {
          if (!canResume()) return;
          console.warn('自动播放失败:', e);
          setTimeout(playVideo, 3000);
        });
      };
      playVideo();
      // 直接监听 pause 事件，不依赖播放器 UI 元素
      const onPause = () => { if (canResume()) playVideo(); };
      video.addEventListener('pause', onPause);
      // 定时兜底：防止 pause 事件被拦截
      const timer = setInterval(() => { if (video.paused && canResume()) playVideo(); }, 5000);
      // 播放器 UI 观察：按钮被点击暂停时 tip 变为「播放」
      const target = document.getElementsByClassName('play-btn-tip')[0];
      let observer = null;
      if (target) {
        observer = new MutationObserver(list => {
          for (const mutation of list) {
            if (mutation.type === 'childList' && target.innerText === '播放' && canResume()) {
              video.play();
            }
          }
        });
        observer.observe(target, { childList: true });
      }
      return () => {
        video.removeEventListener('pause', onPause);
        clearInterval(timer);
        if (observer) observer.disconnect();
      };
    },
    waitForEnd(media, timeout = 0) {
      return new Promise(resolve => {
        if (!media) return resolve();
        if (media.ended) return resolve();
        let timer;
        const onEnded = () => {
          clearTimeout(timer);
          resolve();
        };
        media.addEventListener('ended', onEnded, { once: true });
        if (timeout > 0) {
          timer = setTimeout(() => {
            media.removeEventListener('ended', onEnded);
            resolve();
          }, timeout);
        }
      });
    }
  };

  // ---- ai-workspace 路由工具 ----
  const AiWorkspace = {
    lastMediaPlayback: Store.getMediaPlayback().current,
    persistMediaPlayback(archive = false) {
      if (!this.lastMediaPlayback) return;
      if (archive) Store.archiveMediaPlayback(this.lastMediaPlayback);
      else Store.setCurrentMediaPlayback(this.lastMediaPlayback);
    },
    normalizeText(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    },
    isVisibleElement(element) {
      if (!element || element.nodeType !== 1) return false;
      const view = element.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    },
    getRoute() {
      const match = location.pathname.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/?#]+)/);
      if (!match) return null;
      const [, classroomId, type, leafId] = match;
      const query = new URLSearchParams(location.search);
      return {
        classroomId,
        type,
        leafId,
        nodeId: query.get('node_id') || ''
      };
    },
    getMediaCandidates() {
      return [...document.querySelectorAll('video, audio')].filter(media => {
        if (!(media instanceof HTMLMediaElement)) return false;
        const rect = media.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        return isVisible || media.tagName.toLowerCase() === 'audio';
      });
    },
    snapshotMedia(media, index = -1) {
      if (!media) return null;
      const source = media.currentSrc || media.getAttribute?.('src') || '';
      let sourcePath = '';
      try {
        sourcePath = source ? new URL(source, location.href).pathname.slice(-300) : '';
      } catch (_) {
        sourcePath = source ? '[无法解析]' : '';
      }
      const rect = media.getBoundingClientRect?.() || { width: 0, height: 0 };
      return {
        index,
        tag: media.tagName?.toLowerCase() || '',
        connected: Boolean(media.isConnected),
        visible: rect.width > 0 && rect.height > 0,
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0),
        paused: Boolean(media.paused),
        ended: Boolean(media.ended),
        readyState: Number(media.readyState || 0),
        currentTime: Number(media.currentTime || 0),
        duration: Number(media.duration || 0),
        playbackRate: Number(media.playbackRate || 0),
        sourcePath
      };
    },
    getMedia(preferredType = '') {
      const allCandidates = this.getMediaCandidates();
      const typedCandidates = preferredType
        ? allCandidates.filter(media => media.tagName?.toLowerCase() === preferredType)
        : [];
      const candidates = typedCandidates.length ? typedCandidates : allCandidates;
      if (!candidates.length) {
        const allMedia = [...document.querySelectorAll(preferredType === 'video' || preferredType === 'audio'
          ? preferredType
          : 'video, audio')];
        return allMedia.find(media => !media.ended && media.readyState >= 1)
          || allMedia.find(media => !media.ended)
          || allMedia[0]
          || null;
      }
      const playableCandidates = candidates.filter(media => !media.ended);
      const pool = playableCandidates.length ? playableCandidates : candidates;
      const score = media => {
        const rect = media.getBoundingClientRect();
        const area = rect.width * rect.height;
        const playingBoost = !media.paused && !media.ended ? 1_000_000 : 0;
        const readyBoost = media.readyState >= 2 ? 100_000 : 0;
        return playingBoost + readyBoost + area;
      };
      return [...pool].sort((a, b) => score(b) - score(a))[0];
    },
    isMediaAtPhysicalEnd(media, threshold = 0.25) {
      if (!media) return false;
      const currentTime = Number(media.currentTime || 0);
      const duration = Number(media.duration || 0);
      return Number.isFinite(duration)
        && duration > 1
        && currentTime > 0
        && duration - currentTime <= threshold;
    },
    getPlayerCompletionReason(media, { startTime = 0, minPlayedDelta = 0, expectedSource = '' } = {}) {
      if (!media || !media.isConnected) return '';
      const currentSource = media.currentSrc || media.getAttribute?.('src') || '';
      if (expectedSource && currentSource && currentSource !== expectedSource) return '';
      const currentTime = Number(media?.currentTime || 0);
      const duration = Number(media?.duration || 0);
      const playedDelta = Math.max(0, currentTime - startTime);
      if (media.ended) {
        return this.isMediaAtPhysicalEnd(media) ? 'media-ended-state' : 'premature-ended-state';
      }
      if (playedDelta < minPlayedDelta) return '';
      if (Number.isFinite(duration) && duration > 1 && currentTime > 0 && duration - currentTime <= 0.25) {
        return 'near-end';
      }
      return '';
    },
    keepAlive(shouldResume = () => true, fixedMedia = null) {
      let lastMedia = null;
      const tick = () => {
        if (!shouldResume()) return;
        const media = fixedMedia || this.getMedia();
        if (!media) return;
        if (lastMedia !== media) {
          lastMedia = media;
          media.addEventListener('pause', tick);
        }
        media.muted = true;
        media.defaultMuted = true;
        media.volume = 0;
        media.playbackRate = Config.playbackRate;
        if (media.paused && !media.ended && !Player.isNearEnd(media)) {
          media.play().catch(() => { });
        }
      };
      const timer = setInterval(tick, 500);
      document.addEventListener('visibilitychange', tick);
      window.addEventListener('focus', tick);
      tick();
      return () => {
        clearInterval(timer);
        if (lastMedia) lastMedia.removeEventListener('pause', tick);
        document.removeEventListener('visibilitychange', tick);
        window.removeEventListener('focus', tick);
      };
    },
    getActiveLeafTitle() {
      return this.getActiveLeafElement()?.innerText?.replace(/\s+/g, ' ').trim() || '';
    },
    getActiveLeafElement() {
      const direct = document.querySelector(
        '.leaf-item.is-active, .nav-item-leaf-box.is-active, .nav-item-leaf-box [aria-current="true"], .nav-item-leaf-box [aria-selected="true"]'
      );
      if (direct) return direct;
      const list = this.getAllScourse();
      const activeIndex = this.getActiveCourseIndex(list);
      if (activeIndex < 0) return null;
      const container = list[activeIndex];
      return container.querySelector?.('.is-active, .active, [aria-current="true"], [aria-selected="true"]') || container;
    },
    getActiveLeafCompletion() {
      const active = this.getActiveLeafElement();
      const container = active?.closest?.('.nav-item-leaf-box') || active || null;
      if (!container) {
        return { found: false, isCompleted: false, percent: null, evidence: '未找到当前章节节点' };
      }

      const text = this.normalizeText(container.innerText || container.textContent || '');
      const percentages = [...text.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)]
        .map(match => Number(match[1]))
        .filter(value => Number.isFinite(value) && value >= 0 && value <= 100);
      const markerSignals = [];
      const iconRefs = [];
      let completedByBooleanAttribute = false;
      const allNodes = [container, ...container.querySelectorAll('*')];
      for (const node of allNodes) {
        const className = typeof node.className === 'string'
          ? node.className
          : (node.getAttribute?.('class') || '');
        const id = node.id || '';
        const href = node.getAttribute?.('href')
          || node.getAttribute?.('xlink:href')
          || node.getAttribute?.('usemap')
          || '';
        const ariaLabel = node.getAttribute?.('aria-label') || '';
        const title = node.getAttribute?.('title') || '';
        const status = node.getAttribute?.('data-status')
          || node.getAttribute?.('data-state')
          || node.getAttribute?.('status')
          || '';
        const src = node.getAttribute?.('src') || '';
        const alt = node.getAttribute?.('alt') || '';
        const semanticAttributes = [...(node.attributes || [])]
          .filter(attr => /complete|finish|done|status|state|progress|percent|learn|study|watch/i.test(attr.name))
          .map(attr => `${attr.name}=${attr.value}`);
        if (semanticAttributes.some(value =>
          /(?:complete|completed|finish|finished|done)[^=]*=(?:true|1|complete|completed|finish|finished|done)$/i.test(value)
        )) {
          completedByBooleanAttribute = true;
        }
        const signal = [className, id, href, ariaLabel, title, status, src, alt, ...semanticAttributes]
          .filter(Boolean)
          .join(' ');
        if (signal) markerSignals.push(signal);
        if (href) iconRefs.push(href);

        for (const attrName of ['data-progress', 'data-percent', 'aria-valuenow']) {
          const value = Number(node.getAttribute?.(attrName));
          if (Number.isFinite(value) && value >= 0 && value <= 100) percentages.push(value);
        }
      }
      const progressNodes = [...container.querySelectorAll(
        'progress, [role="progressbar"], [class*="progress"], [class*="percent"]'
      )];
      for (const node of progressNodes) {
        const ariaValue = Number(node.getAttribute('aria-valuenow'));
        if (Number.isFinite(ariaValue) && ariaValue >= 0 && ariaValue <= 100) percentages.push(ariaValue);
        if (node.tagName === 'PROGRESS') {
          const value = Number(node.value);
          const max = Number(node.max || 100);
          if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
            percentages.push(Math.min(100, Math.max(0, value / max * 100)));
          }
        }
      }
      const percent = percentages.length ? Math.max(...percentages) : null;
      const completedByText = /已完成/.test(text);
      const markerText = markerSignals.join(' ').toLowerCase();
      const hasIncompleteMarker = /(?:^|[-_\s])(uncompleted|incomplete|unfinished|not[-_]?complete|todo)(?:$|[-_\s])/.test(markerText);
      const completedByMarker = !hasIncompleteMarker && (completedByBooleanAttribute ||
        /(?:^|[-_#\s])(complete(?:d)?|finish(?:ed)?|done|learned|watched|wancheng|yiwancheng|yixuewan)(?:$|[-_\s])/.test(markerText)
        || /(?:check[-_]?circle|circle[-_]?check|duihao|gou)/.test(markerText)
      );
      const route = this.getRoute();
      const playback = Store.getMediaPlayback();
      const priorRecords = [playback.current, ...playback.history].filter(Boolean);
      const previouslyPlayedByScript = Boolean(route && priorRecords.some(record =>
        record?.route?.leafId === route.leafId
        && record?.route?.type === route.type
        && /^(?:ended-event|media-ended-state|near-end-confirmed-3-times|already-completed-100-percent)$/.test(record.completionReason || '')
      ));
      const isCompleted = completedByText || percent === 100 || completedByMarker;
      const evidence = completedByText
        ? '页面标记已完成'
        : (percent === 100
          ? '页面完成度 100%'
          : (completedByMarker
            ? '页面完成图标或状态类'
            : (percent === null ? '未识别到完成度' : `页面完成度 ${percent}%`)));
      return {
        found: true,
        isCompleted,
        percent,
        evidence,
        completedByText,
        completedByMarker,
        previouslyPlayedByScript,
        markerSignals: [...new Set(markerSignals)].slice(0, 80),
        iconRefs: [...new Set(iconRefs)].slice(0, 30),
        text: text.slice(0, 500)
      };
    },
    getActiveLeafHTML() {
      const active = this.getActiveLeafElement();
      const container = active?.closest?.('.nav-item-leaf-box') || active || null;
      return container?.outerHTML?.slice(0, 15000) || '';
    },
    getCourseListDiagnostics() {
      const list = this.getAllScourse();
      const activeIndex = this.getActiveCourseIndex(list);
      return Array.from(list || []).slice(0, 100).map((element, index) => ({
        index,
        active: index === activeIndex,
        tag: element.tagName || '',
        class: String(element.className || ''),
        text: this.normalizeText(element.innerText || element.textContent || '').slice(0, 500),
        html: element.outerHTML?.slice(0, 5000) || ''
      }));
    },
    getExerciseDocument() {
      const localHasExercise = document.querySelector('#app .container-body .container-problem')
        || document.querySelector('#app .container-problem')
        || document.querySelector('.container-problem');
      if (localHasExercise) return document;

      const frames = [...document.querySelectorAll('iframe')];
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument;
          if (!doc?.body) continue;
          if (
            doc.querySelector('.container-problem')
            || doc.querySelector('.subject-item')
            || doc.querySelector('.item-body')
          ) {
            return doc;
          }
        } catch (_) {
          // ignore cross-document access failures
        }
      }
      return null;
    },
    getExerciseContainer() {
      const exerciseDoc = this.getExerciseDocument();
      return exerciseDoc?.querySelector('#app .container-body .container-problem')
        || exerciseDoc?.querySelector('#app .container-problem')
        || exerciseDoc?.querySelector('.container-problem')
        || null;
    },
    getExerciseQuestionTabs(root = this.getExerciseContainer()) {
      if (!root) return [];
      const selectors = [
        '.subject-item.J_order',
        '.subject-item',
        '.problem-index-item',
        '.question-index-item',
        '[class*="subject-item"]',
        '[class*="problem-index"]',
        '[class*="question-index"]'
      ].join(',');
      const all = [...root.querySelectorAll(selectors)];
      return all.filter((el, index, arr) => {
        if (!this.isVisibleElement(el)) return false;
        if (arr.indexOf(el) !== index) return false;
        const text = this.normalizeText(el.innerText);
        return text && text.length <= 20;
      });
    },
    getExerciseQuestionBody(root = this.getExerciseContainer()) {
      if (!root) return null;
      const itemType = root.querySelector('.item-type');
      if (itemType?.parentElement && this.isVisibleElement(itemType.parentElement)) return itemType.parentElement;
      const selectors = [
        '.item-body',
        '.problem-content',
        '.question-content',
        '.problem-main',
        '.problem-body',
        '.question-body',
        '[class*="problem-content"]',
        '[class*="question-content"]',
        '[class*="problem-body"]',
        '[class*="question-body"]'
      ];
      for (const selector of selectors) {
        const match = [...root.querySelectorAll(selector)].find(el => this.isVisibleElement(el));
        if (match) return match;
      }
      return root;
    },
    isExerciseAnswered(root = this.getExerciseContainer()) {
      if (!root) return false;
      const submitted = [...root.querySelectorAll('button')].some(button =>
        /已提交|已作答/.test(this.normalizeText(button.innerText || button.textContent))
      );
      if (submitted || root.querySelector('.problem-remark .problem-grade')) return true;
      const statusSelectors = [
        '.result',
        '.status',
        '.answer-status',
        '[class*="result"]',
        '[class*="status"]'
      ];
      for (const selector of statusSelectors) {
        const statusNode = [...root.querySelectorAll(selector)]
          .find(el => this.isVisibleElement(el) && /已完成|已作答|已提交|回答正确|回答错误/.test(this.normalizeText(el.innerText)));
        if (statusNode) return true;
      }
      return false;
    },
    getExerciseActionButton(root = this.getExerciseContainer(), pattern = /提交|保存|确认|确定|下一题|下一道|下一步|完成本题/) {
      if (!root) return null;
      const selectors = 'button, .el-button, [role="button"], [class*="button"]';
      const nodes = [
        ...root.querySelectorAll(selectors),
        ...document.querySelectorAll(selectors)
      ];
      return nodes.find(el => this.isVisibleElement(el) && pattern.test(this.normalizeText(el.innerText)));
    },
    getAllScourse() { // 获得ai-workspace的课程列表
      const list = document?.querySelectorAll(".nav-item-leaf-box")
      if (!list) panel.warn("没有发现课程资源")
      return list
    },
    getActiveCourseIndex(list = this.getAllScourse()) {
      return Array.from(list || []).findIndex(element => Boolean(
        element.matches?.('.is-active, .active, [aria-current="true"], [aria-selected="true"]')
        || element.querySelector?.('.leaf-item.is-active, .is-active, .active, [aria-current="true"], [aria-selected="true"]')
      ));
    }
  };

  // ---- 防切屏 ----
  let screenCheckInstalled = false;
  function preventScreenCheck() {
    if (screenCheckInstalled) return;
    screenCheckInstalled = true;
    const win = unsafeWindow;
    const blackList = new Set(['visibilitychange', 'blur', 'pagehide']);
    win._addEventListener = win.addEventListener;
    win.addEventListener = (...args) => blackList.has(args[0]) ? undefined : win._addEventListener(...args);
    document._addEventListener = document.addEventListener;
    document.addEventListener = (...args) => blackList.has(args[0]) ? undefined : document._addEventListener(...args);
    Object.defineProperties(document, {
      hidden: { value: false },
      visibilityState: { value: 'visible' },
      hasFocus: { value: () => true },
      onvisibilitychange: { get: () => undefined, set: () => { } },
      onblur: { get: () => undefined, set: () => { } }
    });
    Object.defineProperties(win, {
      onblur: { get: () => undefined, set: () => { } },
      onpagehide: { get: () => undefined, set: () => { } }
    });
  }

  // ---- 雨课堂动态字体解密（测试版实验功能） ----
  // test.2 使用过的固定字符表仅保留作故障对照，禁止调用：雨课堂映射会随字体变化。
  const DeprecatedStaticFontDecryptor = {
    mapUrl: 'https://cdn.ocsjs.com/resources/font/yuketang_font_map.json',
    map: null,
    loadingPromise: null,
    state: {
      loaded: false,
      loadedAt: '',
      error: '',
      lastRunAt: '',
      encryptedNodeCount: 0,
      decryptedNodeCount: 0,
      replacedCharacterCount: 0,
      unmappedCharacters: []
    },
    selectors: [
      '.xuetangx-com-encrypted-font',
      '[class*="encrypted-font"]',
      '[class*="encrypt-font"]'
    ],
    getEncryptedNodes(root) {
      if (!root?.querySelectorAll) return [];
      const found = [];
      for (const selector of this.selectors) {
        try {
          if (root.matches?.(selector)) found.push(root);
          found.push(...root.querySelectorAll(selector));
        } catch (_) { }
      }
      return [...new Set(found)];
    },
    async loadMap() {
      if (this.map) return this.map;
      if (this.loadingPromise) return this.loadingPromise;
      this.loadingPromise = new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: this.mapUrl,
          timeout: 15000,
          onload: response => {
            try {
              if (response.status < 200 || response.status >= 300) {
                throw new Error(`字体映射请求失败：HTTP ${response.status}`);
              }
              const parsed = JSON.parse(response.responseText || '{}');
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) {
                throw new Error('字体映射内容为空或格式无效');
              }
              this.map = parsed;
              this.state.loaded = true;
              this.state.loadedAt = new Date().toISOString();
              this.state.error = '';
              resolve(parsed);
            } catch (err) {
              this.state.error = String(err?.message || err);
              reject(err);
            }
          },
          onerror: () => {
            const err = new Error('字体映射网络请求失败');
            this.state.error = err.message;
            reject(err);
          },
          ontimeout: () => {
            const err = new Error('字体映射请求超时');
            this.state.error = err.message;
            reject(err);
          }
        });
      }).finally(() => {
        this.loadingPromise = null;
      });
      return this.loadingPromise;
    },
    replaceTextNodes(element, fontMap) {
      let replaced = 0;
      const unmapped = new Set();
      const walker = (element.ownerDocument || document).createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: node => node.parentElement?.closest('[data-ykt-answer-source]')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT
        }
      );
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      for (const node of textNodes) {
        const original = node.nodeValue || '';
        let changed = false;
        const decoded = [...original].map(char => {
          if (Object.prototype.hasOwnProperty.call(fontMap, char)) {
            changed = true;
            replaced++;
            return fontMap[char];
          }
          if (/^[\u3400-\u9fff]$/.test(char)) unmapped.add(char);
          return char;
        }).join('');
        if (changed) node.nodeValue = decoded;
      }
      return { replaced, unmapped: [...unmapped] };
    },
    async decryptRoot(root) {
      const nodes = this.getEncryptedNodes(root);
      this.state.lastRunAt = new Date().toISOString();
      this.state.encryptedNodeCount = nodes.length;
      this.state.decryptedNodeCount = 0;
      this.state.replacedCharacterCount = 0;
      this.state.unmappedCharacters = [];
      if (!nodes.length) return { found: false, decrypted: false, replaced: 0 };

      try {
        const fontMap = await this.loadMap();
        const unmapped = new Set();
        for (const node of nodes) {
          if (node.dataset.yktFontDecrypted === 'true') continue;
          const result = this.replaceTextNodes(node, fontMap);
          result.unmapped.forEach(char => unmapped.add(char));
          this.state.replacedCharacterCount += result.replaced;
          if (result.replaced > 0) {
            this.state.decryptedNodeCount++;
            node.dataset.yktFontDecrypted = 'true';
            [...node.classList]
              .filter(className => /(?:encrypted-font|encrypt-font)/i.test(className))
              .forEach(className => node.classList.remove(className));
          }
        }
        this.state.unmappedCharacters = [...unmapped].slice(0, 100);
        const decrypted = this.state.replacedCharacterCount > 0;
        if (decrypted) {
          panel?.log(`🔓 已在浏览器中还原 ${this.state.replacedCharacterCount} 个加密字符`);
          await Utils.sleep(100);
        }
        return {
          found: true,
          decrypted,
          replaced: this.state.replacedCharacterCount,
          unmapped: this.state.unmappedCharacters
        };
      } catch (err) {
        this.state.error = String(err?.message || err);
        panel?.warn(`字体解密不可用，将回退 OCR：${this.state.error}`);
        return { found: true, decrypted: false, replaced: 0, error: this.state.error };
      }
    },
    getDiagnosticState() {
      return {
        mapUrl: this.mapUrl,
        ...this.state,
        unmappedCharacters: [...this.state.unmappedCharacters]
      };
    }
  };

  // 动态解密由固定版本的 yuketang-deobfuscator 根据当前 exam_font 字形建立映射。
  // 此桥接层只判断它是否已经完成；不会自行替换页面文字，防止错误映射污染题目。
  const FontDecryptor = {
    state: {
      mode: 'dynamic-glyph-hash',
      dependencyCommit: 'eff23eebba1221555d19d10e65a47cd2cd412da5',
      loaded: false,
      error: '',
      lastRunAt: '',
      encryptedNodeCount: 0,
      decryptedNodeCount: 0,
      replacedCharacterCount: 0,
      unmappedCharacters: [],
      fontUrl: ''
    },
    getEncryptedNodes(root) {
      if (!root?.querySelectorAll) return [];
      const nodes = [];
      if (root.matches?.('.xuetangx-com-encrypted-font')) nodes.push(root);
      nodes.push(...root.querySelectorAll('.xuetangx-com-encrypted-font'));
      return [...new Set(nodes)];
    },
    getCurrentFontUrl(doc = document) {
      const pattern = /url\(["']?([^"')]*exam_font_[^"')]+\.ttf[^"')]*)["']?\)/i;
      for (const style of [...doc.querySelectorAll('style')].reverse()) {
        const match = String(style.textContent || '').match(pattern);
        if (match?.[1]) return match[1];
      }
      try {
        for (const sheet of [...doc.styleSheets].reverse()) {
          for (const rule of [...(sheet.cssRules || [])]) {
            const match = String(rule.cssText || '').match(pattern);
            if (match?.[1]) return match[1];
          }
        }
      } catch (_) { }
      return '';
    },
    isDynamicDecryptReady(doc = document) {
      return Boolean(doc.getElementById('deobf-font-override'));
    },
    async decryptRoot(root) {
      const nodes = this.getEncryptedNodes(root);
      this.state.lastRunAt = new Date().toISOString();
      this.state.encryptedNodeCount = nodes.length;
      this.state.decryptedNodeCount = 0;
      this.state.replacedCharacterCount = 0;
      this.state.unmappedCharacters = [];
      this.state.error = '';
      this.state.fontUrl = this.getCurrentFontUrl(root?.ownerDocument || document);
      if (!nodes.length) return { found: false, decrypted: false, replaced: 0 };

      const before = nodes.map(node => node.textContent || '').join('\n');
      let ready = this.isDynamicDecryptReady(root?.ownerDocument || document);
      if (!ready) {
        panel?.log('🔐 检测到动态加密字体，等待解析当前字体映射...');
        ready = await Utils.poll(
          () => this.isDynamicDecryptReady(root?.ownerDocument || document),
          { interval: 200, timeout: 10000 }
        );
      }
      if (!ready) {
        this.state.error = this.state.fontUrl
          ? '动态字体解析超时'
          : '未找到当前作业的动态字体地址';
        panel?.warn(`字体解密未完成，将保持页面原样并回退 OCR：${this.state.error}`);
        return { found: true, decrypted: false, replaced: 0, error: this.state.error };
      }

      // 覆盖字体样式是在替换文本后启用的；多等一个事件循环，避开同一轮 DOM 更新。
      await Utils.sleep(50);
      const after = nodes.map(node => node.textContent || '').join('\n');
      this.state.loaded = true;
      this.state.decryptedNodeCount = nodes.length;
      this.state.replacedCharacterCount = before === after ? 0 : [...after].length;
      panel?.log('🔓 当前动态字体已解析，使用还原后的页面文字');
      return {
        found: true,
        decrypted: true,
        replaced: this.state.replacedCharacterCount,
        alreadyDecrypted: before === after
      };
    },
    getDiagnosticState() {
      return { ...this.state, unmappedCharacters: [...this.state.unmappedCharacters] };
    }
  };

  // ---- OCR & AI ----
  const Solver = {
    pendingManualQuestion: null,
    pendingManualIdentity: '',
    questionIdentity(root) {
      if (!root) return '';
      const type = root.querySelector('.item-type');
      const stem = root.querySelector('.problem-body') || root.querySelector('.item-body');
      return `${location.pathname}|${AiWorkspace.normalizeText(type?.textContent || '')}|${AiWorkspace.normalizeText(stem?.textContent || '')}`;
    },
    getQuestionNumberFromRoot(root) {
      if (!root) return 0;
      const typeText = AiWorkspace.normalizeText(root.querySelector('.item-type')?.textContent || '');
      const match = typeText.match(/^(\d+)\s*[.、．:：]/);
      return match ? Number(match[1]) : 0;
    },
    questionFingerprint(root) {
      if (!root) return '';
      const typeText = AiWorkspace.normalizeText(root.querySelector('.item-type')?.textContent || '');
      const stem = root.querySelector('.problem-body') || root.querySelector('.item-body');
      const stemText = AiWorkspace.normalizeText(stem?.textContent || '');
      const options = this.getOptionElements(root)
        .map(option => this.cleanOptionText(option.innerText || option.textContent || ''))
        .filter(Boolean);
      return `${typeText}|${stemText}|${options.join('|')}`;
    },
    waitForManualQuestion(root) {
      this.pendingManualQuestion = root;
      this.pendingManualIdentity = this.questionIdentity(root);
    },
    lastOCRText: '',
    lastOCRElement: null,
    lastOCRAt: 0,
    lastQuestionTextSource: '',
    lastQuestionBankRequest: null,
    lastQuestionBankResponse: null,
    answerSelectionAudits: {},
    answerSourceObserver: null,
    answerSourceRestoreTimer: null,
    getOptionContainer(element) {
      if (!element) return null;
      const explicit = element.querySelector('.list-inline.list-unstyled-radio')
        || element.querySelector('.list-unstyled.list-unstyled-radio')
        || element.querySelector('.list-unstyled')
        || element.querySelector('ul.list')
        || element.querySelector('[class*="option-list"]')
        || element.querySelector('[class*="answer-list"]')
        || element.querySelector('ul')
        || element.querySelector('[role="radiogroup"]');
      if (explicit) return explicit;
      const control = element.querySelector(
        'label.el-radio, label.el-checkbox, .el-radio, .el-checkbox, [role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]'
      );
      if (!control) return null;
      return control.closest(
        '[role="radiogroup"], [class*="option-list"], [class*="answer-list"], ul, ol'
      ) || control.parentElement?.parentElement || control.parentElement;
    },
    getOptionElements(element) {
      const container = this.getOptionContainer(element);
      const root = container || element;
      if (!root) return [];
      const dedupeOutermost = candidates => [...new Set(candidates)].filter(candidate =>
        !candidates.some(other => other !== candidate && other.contains(candidate))
      );

      let candidates = [...root.querySelectorAll(
        'label.el-radio, label.el-checkbox, .el-radio, .el-checkbox, [role="radio"], [role="checkbox"]'
      )];
      candidates = dedupeOutermost(candidates);
      if (candidates.length >= 2) return candidates;

      candidates = [...root.querySelectorAll(
        'li, .option-item, .answer-item, [class*="option-item"], [class*="answer-item"], label'
      )].filter(candidate => {
        const text = AiWorkspace.normalizeText(candidate.innerText || candidate.textContent || '');
        return text.length > 0 && text.length < 500 && (
          /^[A-FＡ-Ｆ]\s*[.、．:：)）]/i.test(text)
          || /^[①②③④⑤⑥]/.test(text)
          || Boolean(candidate.querySelector('input[type="radio"], input[type="checkbox"]'))
        );
      });
      candidates = dedupeOutermost(candidates);
      if (candidates.length >= 2) return candidates;

      // 最后兼容没有语义标签、仅以普通 div/span 渲染的选项。
      candidates = [...root.querySelectorAll('div, p, span')].filter(candidate => {
        const text = AiWorkspace.normalizeText(candidate.innerText || candidate.textContent || '');
        if (!text || text.length >= 500) return false;
        const markers = text.match(/(?:^|\s)[A-FＡ-Ｆ]\s*[.、．:：)）]/gi) || [];
        return markers.length === 1 && /^[A-FＡ-Ｆ]\s*[.、．:：)）]/i.test(text);
      });
      return candidates.filter(candidate =>
        !candidates.some(other => other !== candidate && candidate.contains(other))
      );
    },
    getFillBlankInputs(element) {
      if (!element?.querySelectorAll) return [];
      const candidates = [...element.querySelectorAll(
        'input.blank-item-dynamic, input[placeholder*="输入答案"], input[type="text"], textarea, [contenteditable="true"]'
      )];
      return [...new Set(candidates)].filter(input => {
        const type = String(input.getAttribute?.('type') || '').toLowerCase();
        return !['radio', 'checkbox', 'hidden', 'button', 'submit'].includes(type)
          && !input.disabled
          && !input.readOnly;
      });
    },
    cleanOptionText(text) {
      return AiWorkspace.normalizeText(text)
        .replace(/^[A-FＡ-Ｆ]\s*[.、．:：)）]\s*/i, '')
        .replace(/^[①②③④⑤⑥]\s*/, '')
        .trim();
    },
    parseOptionsFromText(text) {
      const rawText = String(text || '').replace(/\r/g, '');
      const lines = rawText.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
      const bulletOptions = lines.map(line => {
        const match = line.match(/^[○〇●◯□☐口]\s*(.+)$/);
        return match?.[1]?.trim() || '';
      }).filter(Boolean);
      if (bulletOptions.length >= 2) return bulletOptions;

      const normalized = AiWorkspace.normalizeText(rawText);
      if (!normalized) return [];
      const markerPattern = /(?:^|\s)([A-FＡ-Ｆ])\s*[.、．:：)）]\s*/gi;
      let matches = [...normalized.matchAll(markerPattern)];
      // OCR 有时会吞掉选项字母后的标点，例如“A 北京 B 上海”。
      if (matches.length < 2) {
        const looseMatches = [...normalized.matchAll(/(?:^|\s)([A-FＡ-Ｆ])\s+(?=\S)/gi)];
        const letters = looseMatches.map(match => {
          const char = match[1].toUpperCase();
          return char.charCodeAt(0) > 127 ? String.fromCharCode(char.charCodeAt(0) - 65248) : char;
        });
        const sequential = letters.length >= 2
          && letters[0] === 'A'
          && letters.every((letter, index) => letter.charCodeAt(0) === 65 + index);
        if (sequential) matches = looseMatches;
      }
      if (matches.length < 2) return [];
      const options = matches.map((match, index) => {
        const start = match.index + match[0].length;
        const end = index + 1 < matches.length ? matches[index + 1].index : normalized.length;
        return normalized.slice(start, end).trim();
      }).filter(Boolean);
      return options.length >= 2 ? options : [];
    },
    getAnswerSourceScope() {
      const route = AiWorkspace.getRoute();
      return route
        ? `${location.origin}|${route.classroomId}|${route.leafId}`
        : `${location.origin}|${location.pathname}|${Utils.getCurrentClassroomId()}`;
    },
    getQuestionNumber(label) {
      const match = String(label || '').match(/第\s*(\d+)\s*题/);
      return match ? Number(match[1]) : 0;
    },
    renderAnswerSourceBadge(element, label, source) {
      if (!element) return;
      const ownerDocument = element.ownerDocument || document;
      let badge = element.querySelector('[data-ykt-answer-source]');
      if (!badge) {
        badge = ownerDocument.createElement('div');
        badge.setAttribute('data-ykt-answer-source', 'true');
        badge.setAttribute('data-html2canvas-ignore', 'true');
        badge.style.cssText = [
          'display:inline-block',
          'margin:6px 0',
          'padding:5px 10px',
          'border-radius:6px',
          'font-size:13px',
          'font-weight:600',
          'position:relative',
          'z-index:2'
        ].join(';');
        element.insertBefore(badge, element.firstChild);
      }
      const fromQuestionBank = source === 'ITIHEY 题库';
      badge.style.background = fromQuestionBank ? '#f0f9eb' : '#f5f0ff';
      badge.style.color = fromQuestionBank ? '#389e0d' : '#722ed1';
      badge.style.border = `1px solid ${fromQuestionBank ? '#b7eb8f' : '#d3adf7'}`;
      const badgeText = `${label || '当前题目'} · 答案来源：${source}`;
      if (badge.innerText !== badgeText) badge.innerText = badgeText;
    },
    decorateQuestionTab(root, questionNumber, source) {
      if (!root || !questionNumber) return;
      const tabs = AiWorkspace.getExerciseQuestionTabs(root);
      const tab = tabs[questionNumber - 1];
      if (!tab) return;
      let marker = tab.querySelector('[data-ykt-tab-answer-source]');
      if (!marker) {
        marker = (tab.ownerDocument || document).createElement('small');
        marker.setAttribute('data-ykt-tab-answer-source', 'true');
        marker.setAttribute('data-html2canvas-ignore', 'true');
        marker.style.cssText = 'display:block;margin-top:2px;font-size:10px;line-height:1.2;color:#722ed1;white-space:nowrap;';
        tab.appendChild(marker);
      }
      if (marker.textContent !== source) marker.textContent = source;
      tab.dataset.yktAnswerSource = source;
      tab.title = `第 ${questionNumber} 题答案来源：${source}`;
    },
    showAnswerSource(element, label, source) {
      this.renderAnswerSourceBadge(element, label, source);
      const questionNumber = this.getQuestionNumber(label);
      if (!questionNumber) return;
      Store.setAnswerSource(this.getAnswerSourceScope(), questionNumber, source);
      const root = AiWorkspace.getExerciseContainer()
        || element.closest?.('.container-problem')
        || element.ownerDocument?.body;
      this.decorateQuestionTab(root, questionNumber, source);
    },
    restoreAnswerSources(root = AiWorkspace.getExerciseContainer()) {
      if (!root) return;
      const records = Store.getAnswerSources(this.getAnswerSourceScope());
      for (const [numberText, record] of Object.entries(records)) {
        const questionNumber = Number(numberText);
        if (!questionNumber || !record?.source) continue;
        this.decorateQuestionTab(root, questionNumber, record.source);
      }
      const tabs = AiWorkspace.getExerciseQuestionTabs(root);
      const activeIndex = tabs.findIndex(tab => /active|current|selected|is-active/.test(String(tab.className || '')));
      const questionRoot = AiWorkspace.getExerciseQuestionBody(root);
      const currentNumber = this.getQuestionNumberFromRoot(questionRoot)
        || (activeIndex >= 0 ? activeIndex + 1 : 0);
      const currentRecord = currentNumber ? records[currentNumber] : null;
      if (currentRecord?.source) {
        this.renderAnswerSourceBadge(questionRoot, `第 ${currentNumber} 题`, currentRecord.source);
      } else {
        questionRoot?.querySelector('[data-ykt-answer-source]')?.remove();
      }
    },
    ensureAnswerSourceObserver() {
      if (this.answerSourceObserver) return;
      const exerciseDoc = AiWorkspace.getExerciseDocument() || document;
      const target = exerciseDoc.body || exerciseDoc.documentElement;
      if (!target) return;
      this.answerSourceObserver = new MutationObserver(mutations => {
        const relevant = mutations.some(mutation => {
          if (mutation.type === 'characterData') {
            return !mutation.target.parentElement?.closest('[data-ykt-answer-source], [data-ykt-tab-answer-source]');
          }
          return [...mutation.addedNodes].some(node =>
            node.nodeType === Node.ELEMENT_NODE
            && !node.matches?.('[data-ykt-answer-source], [data-ykt-tab-answer-source]')
          );
        });
        if (!relevant) return;
        clearTimeout(this.answerSourceRestoreTimer);
        this.answerSourceRestoreTimer = setTimeout(() => {
          this.restoreAnswerSources(AiWorkspace.getExerciseContainer());
        }, 120);
      });
      this.answerSourceObserver.observe(target, { childList: true, subtree: true, characterData: true });
    },
    extractQuestionData(element, ocrText = '') {
      const optionElements = this.getOptionElements(element);
      let options = optionElements
        .map(option => this.cleanOptionText(option.innerText || option.textContent || ''))
        .filter(Boolean);
      if (options.length < 2) options = this.parseOptionsFromText(ocrText);

      const selectors = [
        '.question-title', '.problem-title', '.item-title', '.subject-title',
        '.question-stem', '.problem-stem', '.item-stem', '.stem',
        '[class*="question-title"]', '[class*="problem-title"]', '[class*="question-stem"]', '[class*="problem-stem"]'
      ];
      let question = '';
      for (const selector of selectors) {
        const node = [...element.querySelectorAll(selector)].find(item => {
          const text = AiWorkspace.normalizeText(item.innerText || item.textContent || '');
          return text.length > 3 && !this.getOptionContainer(element)?.contains(item);
        });
        if (node) {
          question = AiWorkspace.normalizeText(node.innerText || node.textContent || '');
          break;
        }
      }
      if (!question) {
        const clone = element.cloneNode(true);
        const cloneOptions = this.getOptionContainer(clone);
        if (cloneOptions) cloneOptions.remove();
        this.getFillBlankInputs(clone).forEach(input => {
          input.replaceWith((clone.ownerDocument || document).createTextNode('___'));
        });
        clone.querySelectorAll('button, input, textarea, svg, .item-type, [data-ykt-answer-source]').forEach(node => node.remove());
        question = AiWorkspace.normalizeText(clone.innerText || clone.textContent || '');
      }
      if (!question) question = AiWorkspace.normalizeText(ocrText);
      question = question.replace(/^(单选题|多选题|判断题|选择题)\s*[：:]?\s*/, '').trim();

      const optionText = options.join(' ');
      const fillBlankCount = this.getFillBlankInputs(element).length;
      const hasCheckbox = Boolean(element.querySelector('input[type="checkbox"], .el-checkbox, [role="checkbox"]'));
      let type = fillBlankCount || /填空题/.test(element.innerText || '')
        ? 2
        : (hasCheckbox || /多选题/.test(element.innerText || '') ? 1 : 0);
      if (
        /判断题/.test(element.innerText || '')
        || (options.length === 2 && /^(正确|错误|对|错)\s+(正确|错误|对|错)$/.test(optionText))
      ) {
        type = 3;
      }
      return { question, options, type, fillBlankCount };
    },
    buildDecryptedDOMText(element) {
      const data = this.extractQuestionData(element, '');
      if (!data.question || data.question.length <= 5) return '';
      const optionLines = data.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`);
      const text = [data.question, ...optionLines].filter(Boolean).join('\n');
      this.lastQuestionTextSource = '浏览器字体解密后的 DOM';
      return text;
    },
    async askQuestionBank(element, ocrText = '') {
      const conf = Store.getQuestionBankConf();
      if (!conf.enabled) throw new Error('题库未启用');
      if (!conf.key) throw new Error('未填写 ITIHEY API Key');

      const payload = this.extractQuestionData(element, ocrText);
      if (!payload.question) throw new Error('未能提取题干');
      const requestPayload = {
        question: payload.question,
        type: payload.type
      };
      if (payload.options.length) requestPayload.options = payload.options;
      else if (payload.type === 2) panel.log(`识别到填空题（${payload.fillBlankCount || 1} 个空），正在按填空题查询题库`);
      else panel.log('未识别到选项，将使用题干直接查询题库');
      this.lastQuestionBankRequest = {
        sentAt: new Date().toISOString(),
        payload: JSON.parse(JSON.stringify(requestPayload)),
        questionTextSource: this.lastQuestionTextSource
      };

      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: conf.url || 'https://platform.itihey.com/v1/search',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': conf.key
          },
          data: JSON.stringify(requestPayload),
          timeout: 30000,
          onload: res => {
            let json;
            try {
              json = JSON.parse(res.responseText || '{}');
            } catch (_) {
              reject(new Error('题库返回内容不是有效 JSON'));
              return;
            }
            if (res.status !== 200) {
              reject(new Error(json.message || json.error || `题库请求失败：HTTP ${res.status}`));
              return;
            }

            const indexes = Array.isArray(json.answer_index)
              ? json.answer_index.filter(index => Number.isInteger(index) && index >= 0 && index < payload.options.length)
              : [];
            const keys = Array.isArray(json.answer_key)
              ? json.answer_key.map(key => String(key).trim().toUpperCase()).filter(key => /^[A-F]$/.test(key))
              : [];
            if (!keys.length) {
              indexes.forEach(index => keys.push(String.fromCharCode(65 + index)));
            }
            if (!keys.length && Array.isArray(json.answer_string)) {
              json.answer_string.forEach(answer => {
                const normalized = this.cleanOptionText(answer);
                const index = payload.options.findIndex(option => this.cleanOptionText(option) === normalized);
                if (index >= 0) keys.push(String.fromCharCode(65 + index));
              });
            }
            const uniqueKeys = [...new Set(keys)];
            const answerStrings = Array.isArray(json.answer_string)
              ? json.answer_string.map(answer => String(answer).trim()).filter(Boolean)
              : [];
            if (!uniqueKeys.length && !answerStrings.length) {
              reject(new Error('题库未返回有效答案'));
              return;
            }
            this.lastQuestionBankResponse = {
              receivedAt: new Date().toISOString(),
              answerKeys: uniqueKeys,
              answerStrings,
              useAI: Boolean(json.use_ai),
              usage: Number(json.usage || 0)
            };
            resolve({
              answerText: uniqueKeys.length ? `正确答案：${uniqueKeys.join('')}` : '',
              answerStrings,
              source: json.use_ai ? 'ITIHEY AI' : 'ITIHEY 题库',
              usage: Number(json.usage || 0)
            });
          },
          onerror: () => reject(new Error('题库网络请求失败')),
          ontimeout: () => reject(new Error('题库请求超时'))
        });
      });
    },
    async resolveAnswer(element, ocrText, optionCount = 0, { skipQuestionBank = false } = {}) {
      const questionBank = Store.getQuestionBankConf();
      const aiEnabled = Store.getFeatureConf().autoAI;
      if (!questionBank.enabled && !aiEnabled) {
        throw new Error('请选择答题方式');
      }
      if (questionBank.enabled && !skipQuestionBank) {
        try {
          panel.log('🔎 正在优先查询 ITIHEY 题库...');
          const result = await this.askQuestionBank(element, ocrText);
          const usageText = result.usage ? `，消耗 ${(result.usage / 100000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} 海浪` : '';
          panel.log(`✅ ${result.source} 已返回答案${usageText}`);
          return result;
        } catch (err) {
          panel.log(`题库未取得有效答案：${err.message || err}`);
          if (!aiEnabled) throw new Error('题库未取得有效答案，且 AI 答题未启用');
          panel.log('🤖 正在回退到当前 AI 配置...');
        }
      }
      if (!aiEnabled) throw new Error('AI 答题未启用');
      const questionData = this.extractQuestionData(element, ocrText);
      const answerText = await this.askAI(ocrText, optionCount, {
        type: questionData.type,
        blankCount: questionData.fillBlankCount || 0
      });
      return { answerText, answerStrings: [], source: '自定义 AI', usage: 0 };
    },
    async recognize(element) {
      if (!element) return '无元素';
      try {
        panel.log('正在截图...');
        const canvas = await html2canvas(element, {
          useCORS: true,
          logging: false,
          scale: 2,
          backgroundColor: '#ffffff'
        });
        panel.log('正在 OCR 识别 (首轮较慢)...');
        const { data: { text } } = await Tesseract.recognize(canvas, 'chi_sim', {
          logger: m => {
            if (m.status === 'downloading tesseract lang') {
              console.log(`正在下载语言包 ${(m.progress * 100).toFixed(0)}%`);
            }
          }
        });
        const recognizedText = text
          .replace(/\r/g, '')
          .split('\n')
          .map(line => line.replace(/[ \t]+/g, ' ').trim())
          .filter(Boolean)
          .join('\n');
        this.lastOCRText = recognizedText;
        this.lastOCRElement = element;
        this.lastOCRAt = Date.now();
        this.lastQuestionTextSource = 'OCR';
        console.log('[雨课堂定制版] OCR 识别结果：', recognizedText);
        return recognizedText;
      } catch (err) {
        console.error('OCR error:', err);
        panel.log(`OCR 失败: ${err.message || '网络错误'}`);
        return 'OCR识别出错';
      }
    },
    async askAI(ocrText, optionCount = 0, { type = 0, blankCount = 0 } = {}) {
      const saved = Store.getAIConf();
      const API_URL = saved.url;
      const API_KEY = saved.key;
      const MODEL_NAME = saved.model;
      const API_FORMAT = saved.apiFormat || 'openai';
      const AUTH_METHOD = saved.authMethod || 'bearer';
      return new Promise((resolve, reject) => {
        if (!API_KEY || API_KEY.includes('sk-xxxx')) {
          const msg = '⚠️ 请在 [AI配置] 中填写有效的 API Key';
          panel.log(msg);
          reject(msg);
          return;
        }
        const maxChar = String.fromCharCode(65 + optionCount - 1);
        const rangeStr = optionCount ? `A-${maxChar}` : 'A-D';
        const isFillBlank = type === 2 || blankCount > 0;
        const prompt = isFillBlank ? `
你是专业做题助手，请完成下面的填空题。
强约束：
1) 本题共有 ${blankCount || 1} 个空，按题目中的出现顺序作答
2) 不要解释，不要复述题目
3) 一个空输出：正确答案：答案内容
4) 多个空输出：正确答案：答案1|||答案2，答案数量必须与空格数量一致
题目内容：
${ocrText}
` : `
你是专业做题助手，请分析 OCR 文本，判断题型后给出答案。
强约束：
1) 本题只有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}
2) 忽略 OCR 错误的选项字母，按出现顺序映射 A/B/C/D...
3) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对/错
题目内容：
${ocrText}
`;
        const systemPrompt = isFillBlank
          ? '你是一个只输出填空答案的助手。多个空使用|||分隔。'
          : "你是一个只输出答案的助手。判断题输出'对'或'错'，选择题输出字母。";

        // 构建认证 header
        const authHeader = AUTH_METHOD === 'x-api-key'
          ? { 'x-api-key': API_KEY }
          : { 'Authorization': `Bearer ${API_KEY}` };

        if (API_FORMAT === 'anthropic') {
          // Anthropic API 格式
          const headers = {
            'Content-Type': 'application/json',
            ...authHeader
          };
          // 只有原生 Anthropic API 才需要 anthropic-version，代理通常不需要
          if (API_URL.includes('api.anthropic.com')) {
            headers['anthropic-version'] = '2023-06-01';
          }
          const requestBody = {
            model: MODEL_NAME,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [
              { role: 'user', content: prompt }
            ]
          };
          // 调试日志
          console.log('[AI请求] URL:', API_URL);
          console.log('[AI请求] Headers:', headers);
          console.log('[AI请求] Body:', requestBody);
          panel.log(`请求 ${API_URL}...`);
          GM_xmlhttpRequest({
            method: 'POST',
            url: API_URL,
            headers,
            data: JSON.stringify(requestBody),
            data: JSON.stringify({
              model: MODEL_NAME,
              max_tokens: 1024,
              system: systemPrompt,
              messages: [
                { role: 'user', content: prompt }
              ]
            }),
            timeout: 120000, // 120秒，思考模型需要更长响应时间
            onload: res => {
              console.log('[AI响应] Status:', res.status);
              console.log('[AI响应] Response:', res.responseText);
              if (res.status === 200) {
                try {
                  const json = JSON.parse(res.responseText);
                  // Anthropic 返回格式: content[0].text
                  const answerText = json.content?.[0]?.text || json.choices?.[0]?.message?.content;
                  resolve(answerText);
                } catch (e) {
                  reject('JSON 解析失败');
                }
              } else {
                const err = `请求失败: HTTP ${res.status} - ${res.responseText}`;
                panel.log(err);
                reject(err);
              }
            },
            onerror: () => reject('网络错误'),
            ontimeout: () => reject('请求超时')
          });
        } else {
          // OpenAI API 格式（默认）
          GM_xmlhttpRequest({
            method: 'POST',
            url: API_URL,
            headers: {
              'Content-Type': 'application/json',
              ...authHeader
            },
            data: JSON.stringify({
              model: MODEL_NAME,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
              ],
              temperature: 0.1
            }),
            timeout: 120000, // 120秒，思考模型需要更长响应时间
            onload: res => {
              if (res.status === 200) {
                try {
                  const json = JSON.parse(res.responseText);
                  const answerText = json.choices[0].message.content;
                  resolve(answerText);
                } catch (e) {
                  reject('JSON 解析失败');
                }
              } else {
                const err = `请求失败: HTTP ${res.status}`;
                panel.log(err);
                reject(err);
              }
            },
            onerror: () => reject('网络错误'),
            ontimeout: () => reject('请求超时')
          });
        }
      });
    },
    extractAnswerText(value) {
      const text = String(value || '').trim();
      const explicit = [...text.matchAll(/(?:正确答案\s*[：:]|答案\s*[：:]|答案选(?:择)?)\s*([^\n。；;]+)/g)];
      return (explicit.length ? explicit[explicit.length - 1][1] : text)
        .trim().replace(/[。；;]+$/, '').trim();
    },
    parseFillBlankAnswers(aiResponse, answerStrings, blankCount) {
      let answers = answerStrings.map(value => this.extractAnswerText(value)).filter(Boolean);
      if (!answers.length && aiResponse) {
        const extracted = this.extractAnswerText(aiResponse);
        if (extracted) answers = [extracted];
      }
      if (answers.length === 1 && blankCount > 1) {
        const combined = answers[0];
        const separators = [
          /\s*\|\|\|\s*/,
          /\r?\n+/,
          /\s*[、；;]\s*/,
          /\s*[，,]\s*/
        ];
        for (const separator of separators) {
          const candidate = combined.split(separator).map(value => value.trim()).filter(Boolean);
          if (candidate.length === blankCount) {
            answers = candidate;
            break;
          }
        }
      }
      answers = answers.map(answer => String(answer)
        .replace(/^\s*(?:第?\s*\d+\s*空|\d+)\s*[.、:：)）-]\s*/, '')
        .replace(/^[“”"']+|[“”"']+$/g, '')
        .trim()
      ).filter(Boolean);
      if (blankCount === 1 && answers.length) return [answers[0]];
      return answers.length === blankCount ? answers : [];
    },
    setFillBlankValue(input, value) {
      const ownerWindow = input.ownerDocument?.defaultView || window;
      input.focus?.();
      if (input.isContentEditable) {
        input.textContent = value;
      } else {
        const prototype = input.tagName === 'TEXTAREA'
          ? ownerWindow.HTMLTextAreaElement?.prototype
          : ownerWindow.HTMLInputElement?.prototype;
        const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
      }
      input.dispatchEvent(new ownerWindow.Event('input', { bubbles: true }));
      input.dispatchEvent(new ownerWindow.Event('change', { bubbles: true }));
      input.dispatchEvent(new ownerWindow.Event('blur', { bubbles: true }));
    },
    async finalizeSelectedAnswer(itemBodyElement, savedMessage = '答案已勾选') {
      const featureFlags = Store.getFeatureConf();
      if (featureFlags.answerSubmitMode !== 'auto') {
        panel.log(`${savedMessage}，未自动提交`);
        return {
          selected: true,
          submitted: false,
          requiresManualSubmit: false,
          pauseAfterChapter: featureFlags.saveOnlyAction === 'manual'
        };
      }

      const findSubmitButton = () => {
        const ownerDocument = itemBodyElement.ownerDocument || document;
        const roots = [itemBodyElement.parentElement, itemBodyElement, ownerDocument].filter(Boolean);
        const matchText = text => /提交|保存|确认|确定|提交答案/.test(text);
        const isUsable = button => button.offsetParent !== null
          && !button.disabled
          && button.getAttribute('aria-disabled') !== 'true'
          && !button.classList.contains('is-disabled');
        for (const root of roots) {
          const local = root.querySelectorAll('button, .el-button, [role="button"]');
          for (const button of local) {
            if (isUsable(button) && matchText(button.innerText || '')) return button;
          }
        }
        return null;
      };
      let submitBtn = findSubmitButton();
      if (!submitBtn) {
        await Utils.poll(() => Boolean(submitBtn = findSubmitButton()), { interval: 100, timeout: 2000 });
      }
      if (!submitBtn) {
        panel.warn('未找到可用的提交按钮，已保留所填答案并暂停自动跳转');
        return { selected: true, submitted: false, requiresManualSubmit: true };
      }
      panel.log('正在自动提交答案...');
      submitBtn.click();
      await Utils.sleep(500);
      return { selected: true, submitted: true, requiresManualSubmit: false };
    },
    getSelectionFailureMessage(result) {
      if (result?.reason === 'fill-answer-count-mismatch') {
        return `填空答案无法安全对应到 ${result.blankCount || '全部'} 个空格，已停止填写。请检查题库返回内容或导出诊断`;
      }
      if (result?.reason === 'fill-value-not-retained') {
        return '填空答案写入后未被页面保留，已停止处理。请导出诊断';
      }
      if (result?.reason === 'option-selection-incomplete') {
        return `页面未能保留全部选择，缺少选项：${(result.missingKeys || []).join('、') || '未知'}。已停止处理，请检查页面或导出诊断`;
      }
      if (result?.reason === 'ungraded-option-not-found' || result?.reason === 'ungraded-option-not-selected') {
        return '检测到不计分题，但未能找到或选中任一选项。已停止处理，请导出诊断';
      }
      return '已取得答案但无法定位选项，已停止重复查询。请在当前页面导出诊断';
    },
    isOptionSelected(option) {
      if (!option) return false;
      const input = option.matches?.('input') ? option : option.querySelector('input[type="radio"], input[type="checkbox"]');
      return Boolean(
        input?.checked
        || option.getAttribute?.('aria-checked') === 'true'
        || option.classList?.contains('is-checked')
        || option.classList?.contains('checked')
        || option.querySelector?.('[aria-checked="true"], .is-checked, input:checked')
      );
    },
    getSelectedOptionIndices(element) {
      return this.getOptionElements(element)
        .map((option, index) => this.isOptionSelected(option) ? index : -1)
        .filter(index => index >= 0);
    },
    isUngradedQuestion(element) {
      if (!element) return false;
      const typeNode = element.matches?.('.item-type')
        ? element
        : (element.querySelector?.('.item-type')
          || element.closest?.('.container-problem')?.querySelector?.('.item-type'));
      const typeText = AiWorkspace.normalizeText(
        typeNode?.innerText || typeNode?.textContent || ''
      );
      return /不计分|投票题|问卷题|调查题/.test(typeText);
    },
    async selectAnyUngradedAnswer(itemBodyElement, preferredIndices = []) {
      const options = this.getOptionElements(itemBodyElement);
      if (!options.length) {
        return { selected: false, reason: 'ungraded-option-not-found', ungraded: true, verified: false };
      }

      let selectedIndices = this.getSelectedOptionIndices(itemBodyElement);
      if (!selectedIndices.length) {
        const preferredIndex = preferredIndices.find(index => options[index]) ?? 0;
        const currentOption = options[preferredIndex];
        const clickable = currentOption.querySelector(
          'label.el-radio, label.el-checkbox, .el-radio__label, .el-checkbox__label, [role="radio"], [role="checkbox"], input'
        ) || currentOption;
        clickable.click();
        await Utils.sleep(250);
        selectedIndices = this.getSelectedOptionIndices(itemBodyElement);
      }

      if (!selectedIndices.length) {
        return { selected: false, reason: 'ungraded-option-not-selected', ungraded: true, verified: false };
      }

      const selectedKeys = selectedIndices.map(index => String.fromCharCode(65 + index));
      const acceptedKey = selectedKeys[0];
      panel.log(`🗳️ 检测到不计分投票/问卷题，任选一项即可；已保留选项：${acceptedKey}`);
      const finalResult = await this.finalizeSelectedAnswer(itemBodyElement);
      return {
        ...finalResult,
        intendedKeys: [acceptedKey],
        selectedKeys,
        ungraded: true,
        acceptedAny: true,
        verified: true
      };
    },
    recordSelectionAudit(label, source, selectionResult) {
      const questionNumber = this.getQuestionNumber(label);
      if (!questionNumber) return;
      this.answerSelectionAudits[questionNumber] = {
        recordedAt: new Date().toISOString(),
        source,
        intendedKeys: selectionResult?.intendedKeys || [],
        selectedKeys: selectionResult?.selectedKeys || [],
        fillAnswers: selectionResult?.fillAnswers || [],
        ungraded: Boolean(selectionResult?.ungraded),
        acceptedAny: Boolean(selectionResult?.acceptedAny),
        verified: selectionResult?.verified !== false
      };
    },
    async autoSelectAnswer(aiResponse, itemBodyElement, answerStrings = []) {
      answerStrings = answerStrings.map(value => this.extractAnswerText(value)).filter(Boolean);
      const fillBlankInputs = this.getFillBlankInputs(itemBodyElement);
      if (fillBlankInputs.length) {
        const fillAnswers = this.parseFillBlankAnswers(aiResponse, answerStrings, fillBlankInputs.length);
        if (fillAnswers.length !== fillBlankInputs.length) {
          const rawAnswerCount = answerStrings.length || (aiResponse ? 1 : 0);
          panel.log(`⚠️ 已取得填空答案，但无法安全拆分为 ${fillBlankInputs.length} 个答案（题库返回 ${rawAnswerCount} 项）`);
          return {
            selected: false,
            reason: 'fill-answer-count-mismatch',
            answerCount: rawAnswerCount,
            blankCount: fillBlankInputs.length
          };
        }
        fillBlankInputs.forEach((input, index) => this.setFillBlankValue(input, fillAnswers[index]));
        await Utils.sleep(300);
        const valuesApplied = fillBlankInputs.every((input, index) => {
          const actual = input.isContentEditable ? input.textContent : input.value;
          return String(actual || '').trim() === fillAnswers[index];
        });
        if (!valuesApplied) {
          panel.log('⚠️ 填空答案已尝试写入，但页面未保留输入值');
          return { selected: false, reason: 'fill-value-not-retained' };
        }
        panel.log(`✅ 建议填入：${fillAnswers.join(' | ')}`);
        const finalResult = await this.finalizeSelectedAnswer(itemBodyElement, '填空答案已写入');
        return { ...finalResult, fillAnswers, verified: true };
      }
      const match = String(aiResponse || '').match(/(?:正确)?答案[：:]?\s*([A-F]+(?:[,，][A-F]+)*|[对错]|正确|错误)/i);
      const answerRaw = match ? match[1].replace(/[,，]/g, '').trim() : '';
      const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5 };
      let targetIndices = [];
      if (answerRaw === '对' || answerRaw === '正确') {
        targetIndices = [0];
      } else if (answerRaw === '错' || answerRaw === '错误') {
        targetIndices = [1];
      } else {
        for (const char of answerRaw.toUpperCase()) {
          if (map[char] !== undefined) targetIndices.push(map[char]);
        }
      }
      const options = this.getOptionElements(itemBodyElement);
      const directTargets = [];
      if (!targetIndices.length && answerStrings.length) {
        for (const answer of answerStrings) {
          const normalizedAnswer = this.cleanOptionText(answer);
          const optionIndex = options.findIndex(option =>
            this.cleanOptionText(option.innerText || option.textContent || '') === normalizedAnswer
          );
          if (optionIndex >= 0) {
            targetIndices.push(optionIndex);
            continue;
          }

          const candidates = [...itemBodyElement.querySelectorAll(
            'label, li, [role="radio"], [role="checkbox"], .el-radio, .el-checkbox, [class*="option"], [class*="answer"], div, p, span'
          )].filter(node => {
            const text = this.cleanOptionText(node.innerText || node.textContent || '');
            return text && text === normalizedAnswer;
          }).sort((a, b) => a.childElementCount - b.childElementCount);
          const matched = candidates[0];
          if (matched) {
            directTargets.push(
              matched.closest('label, li, [role="radio"], [role="checkbox"], .el-radio, .el-checkbox, [class*="option-item"], [class*="answer-item"]')
              || matched
            );
          }
        }
      }
      targetIndices = [...new Set(targetIndices)];
      const answerDisplay = answerRaw || answerStrings.join('、');
      if (this.isUngradedQuestion(itemBodyElement)) {
        return this.selectAnyUngradedAnswer(itemBodyElement, targetIndices);
      }
      if (!targetIndices.length && !directTargets.length) {
        panel.log(`⚠️ 已取得答案${answerDisplay ? `“${answerDisplay}”` : ''}，但未能定位可点击的页面选项`);
        return false;
      }
      panel.log(`✅ 建议选择：${answerDisplay}`);

      let selectedCount = 0;
      for (const idx of targetIndices) {
        const currentOption = this.getOptionElements(itemBodyElement)[idx];
        if (!currentOption) continue;
        if (this.isOptionSelected(currentOption)) {
          selectedCount++;
          continue;
        }
        const clickable = currentOption.querySelector('label.el-radio') ||
          currentOption.querySelector('label.el-checkbox') ||
          currentOption.querySelector('.el-radio__label') ||
          currentOption.querySelector('.el-checkbox__label') ||
          currentOption.querySelector('[role="radio"]') ||
          currentOption.querySelector('[role="checkbox"]') ||
          currentOption.querySelector('input') ||
          currentOption;
        clickable.click();
        selectedCount++;
        await Utils.sleep(150);
      }
      for (const target of [...new Set(directTargets)]) {
        if (!this.isOptionSelected(target)) target.click();
        selectedCount++;
        await Utils.sleep(150);
      }
      if (!selectedCount) return false;
      let selectedIndices = this.getSelectedOptionIndices(itemBodyElement);
      let missingIndices = targetIndices.filter(index => !selectedIndices.includes(index));
      if (missingIndices.length) {
        panel.log(`检测到选项 ${missingIndices.map(index => String.fromCharCode(65 + index)).join('、')} 未保持选中，正在补选一次`);
        for (const idx of missingIndices) {
          const currentOption = this.getOptionElements(itemBodyElement)[idx];
          if (!currentOption || this.isOptionSelected(currentOption)) continue;
          const clickable = currentOption.querySelector(
            'label.el-radio, label.el-checkbox, .el-radio__label, .el-checkbox__label, [role="radio"], [role="checkbox"], input'
          ) || currentOption;
          clickable.click();
          await Utils.sleep(180);
        }
        selectedIndices = this.getSelectedOptionIndices(itemBodyElement);
        missingIndices = targetIndices.filter(index => !selectedIndices.includes(index));
      }
      const intendedKeys = targetIndices.map(index => String.fromCharCode(65 + index));
      const selectedKeys = selectedIndices.map(index => String.fromCharCode(65 + index));
      if (missingIndices.length) {
        return {
          selected: false,
          reason: 'option-selection-incomplete',
          intendedKeys,
          selectedKeys,
          missingKeys: missingIndices.map(index => String.fromCharCode(65 + index)),
          verified: false
        };
      }
      if (targetIndices.length) panel.log(`✅ 已确认页面实际选中：${selectedKeys.join('')}`);
      const finalResult = await this.finalizeSelectedAnswer(itemBodyElement);
      return { ...finalResult, intendedKeys, selectedKeys, verified: true };
    }
  };

  // ---- 诊断数据导出（不包含 Cookie、localStorage 或 API Key） ----
  function exportDiagnostics(ui) {
    const exerciseDoc = AiWorkspace.getExerciseDocument() || document;
    const root = AiWorkspace.getExerciseContainer()
      || exerciseDoc.querySelector('.item-type')?.parentElement
      || exerciseDoc.querySelector('.item-body')
      || exerciseDoc.querySelector('.subject-item.J_order.is-active')
      || exerciseDoc.querySelector('.subject-item.J_order')
      || exerciseDoc.querySelector('.container-problem')
      || (Solver.lastOCRElement?.isConnected ? Solver.lastOCRElement : null)
      || null;

    const ocrMatchesCurrent = Boolean(
      root
      && Solver.lastOCRElement
      && (root === Solver.lastOCRElement || root.contains(Solver.lastOCRElement))
    );
    const ocrText = ocrMatchesCurrent ? Solver.lastOCRText : '';
    const optionElements = root ? Solver.getOptionElements(root) : [];
    const fillBlankInputs = root ? Solver.getFillBlankInputs(root) : [];
    const extracted = root
      ? Solver.extractQuestionData(root, ocrText)
      : { question: '', options: [], type: 0 };

    const selectorList = [
      '.list-inline.list-unstyled-radio',
      '.list-unstyled.list-unstyled-radio',
      '.list-unstyled',
      'ul.list',
      '[class*="option-list"]',
      '[class*="answer-list"]',
      '[role="radiogroup"]',
      'label.el-radio',
      'label.el-checkbox',
      '.el-radio',
      '.el-checkbox',
      '[role="radio"]',
      '[role="checkbox"]',
      'input[type="radio"]',
      'input[type="checkbox"]',
      '.option-item',
      '.answer-item'
    ];
    const selectorStats = {};
    for (const selector of selectorList) {
      try {
        selectorStats[selector] = root ? root.querySelectorAll(selector).length : 0;
      } catch (err) {
        selectorStats[selector] = `选择器错误：${err.message || err}`;
      }
    }

    const sanitizeHTML = element => {
      if (!element) return '';
      const clone = element.cloneNode(true);
      clone.querySelectorAll('script, style, video, audio, source, canvas, #ykt-helper-iframe').forEach(node => node.remove());
      clone.querySelectorAll('*').forEach(node => {
        for (const attr of [...node.attributes]) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on') || /token|authorization|cookie|secret|api[-_]?key/i.test(name)) {
            node.removeAttribute(attr.name);
          }
        }
        if (node.matches('input, textarea')) {
          node.removeAttribute('value');
          if ('value' in node) node.value = '';
          if (node.matches('textarea')) node.textContent = '';
        }
        if (node.matches('img, iframe')) {
          if (node.hasAttribute('src')) node.setAttribute('src', '[已移除]');
          if (node.hasAttribute('srcset')) node.removeAttribute('srcset');
        }
      });
      return clone.outerHTML.slice(0, 500000);
    };

    const aiConf = Store.getAIConf();
    const questionBankConf = Store.getQuestionBankConf();
    const featureConf = Store.getFeatureConf();
    const report = {
      reportType: '雨课堂定制版诊断数据',
      scriptVersion: Config.version,
      exportedAt: new Date().toISOString(),
      page: {
        origin: location.origin,
        pathname: location.pathname,
        title: document.title
      },
      route: AiWorkspace.getRoute(),
      environment: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        viewport: { width: window.innerWidth, height: window.innerHeight }
      },
      configuration: {
        questionBank: {
          enabled: questionBankConf.enabled,
          url: questionBankConf.url,
          hasKey: Boolean(questionBankConf.key)
        },
        ai: {
          enabled: featureConf.autoAI,
          url: aiConf.url,
          model: aiConf.model,
          apiFormat: aiConf.apiFormat,
          authMethod: aiConf.authMethod,
          hasKey: Boolean(aiConf.key && !aiConf.key.includes('sk-xxxx'))
        },
        answerSubmitMode: featureConf.answerSubmitMode,
        saveOnlyAction: featureConf.saveOnlyAction
      },
      experimentalFeatures: {
        browserFontDecryption: FontDecryptor.getDiagnosticState()
      },
      mediaPlayback: {
        last: AiWorkspace.lastMediaPlayback,
        persisted: Store.getMediaPlayback(),
        activeCourseCompletion: AiWorkspace.getActiveLeafCompletion(),
        activeCourseHTML: AiWorkspace.getActiveLeafHTML(),
        courseList: AiWorkspace.getCourseListDiagnostics(),
        currentCandidates: AiWorkspace.getMediaCandidates().map((media, index) =>
          AiWorkspace.snapshotMedia(media, index)
        )
      },
      lastQuestionBankRequest: Solver.lastQuestionBankRequest,
      lastQuestionBankResponse: Solver.lastQuestionBankResponse,
      answerSelectionAudits: Solver.answerSelectionAudits,
      savedAnswerSources: Store.getAnswerSources(Solver.getAnswerSourceScope()),
      currentQuestion: {
        found: Boolean(root),
        rootTag: root?.tagName || '',
        rootId: root?.id || '',
        rootClass: String(root?.className || ''),
        extractedQuestion: extracted.question,
        extractedOptions: extracted.options,
        inferredType: extracted.type,
        ungraded: root ? Solver.isUngradedQuestion(root) : false,
        optionElementCount: optionElements.length,
        fillBlankInputCount: fillBlankInputs.length,
        fillBlankInputs: fillBlankInputs.map((input, index) => ({
          index,
          tag: input.tagName,
          type: input.getAttribute('type') || '',
          class: String(input.className || ''),
          placeholder: input.getAttribute('placeholder') || '',
          value: input.isContentEditable ? input.textContent : input.value,
          disabled: Boolean(input.disabled),
          readOnly: Boolean(input.readOnly)
        })),
        optionElements: optionElements.map((element, index) => ({
          index,
          tag: element.tagName,
          id: element.id || '',
          class: String(element.className || ''),
          role: element.getAttribute('role') || '',
          text: AiWorkspace.normalizeText(element.innerText || element.textContent || '').slice(0, 1000),
          html: sanitizeHTML(element).slice(0, 5000)
        })),
        selectorStats,
        ocrMatchesCurrent,
        ocrAt: ocrMatchesCurrent && Solver.lastOCRAt ? new Date(Solver.lastOCRAt).toISOString() : '',
        ocrText,
        sanitizedHTML: sanitizeHTML(root)
      },
      fallbackPageHTML: root ? '' : sanitizeHTML(exerciseDoc.body),
      lastOCR: {
        text: Solver.lastOCRText,
        at: Solver.lastOCRAt ? new Date(Solver.lastOCRAt).toISOString() : '',
        currentQuestionTextSource: Solver.lastQuestionTextSource,
        note: '最近一次 OCR，不保证对应当前题目'
      },
      frames: [...document.querySelectorAll('iframe')]
        .filter(frame => frame.id !== 'ykt-helper-iframe')
        .map(frame => {
          try {
            return { id: frame.id, class: frame.className,
              accessible: Boolean(frame.contentDocument?.body),
              html: root ? '' : sanitizeHTML(frame.contentDocument?.body) };
          } catch (_) {
            return { id: frame.id, class: frame.className, accessible: false };
          }
        }),
      panelLog: (ui.info?.innerText || '').slice(-30000),
      privacy: '本报告未导出 Cookie、localStorage 原始内容或 API Key；仅保留功能开关和 hasKey 布尔值，输入框值已移除，媒体仅保留不含域名和查询参数的路径。'
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    link.download = `雨课堂诊断-${stamp}.json`;
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (panel?.log) {
      panel.log('✅ 诊断数据已导出，请将 JSON 文件发给开发者');
    } else {
      console.log('[雨课堂定制版] 诊断数据已导出');
    }
  }

  // ---- v2 逻辑 ----
  class V2Runner {
    constructor(panel) {
      this.panel = panel;
      this.baseUrl = location.href;
      const { current } = Store.getProgress(this.baseUrl);
      this.outside = current.outside;
      this.inside = current.inside;
      this.shouldStop = false;
      this.manualSubmitRequired = false;
    }

    updateProgress(outside, inside = 0) {
      this.outside = outside;
      this.inside = inside;
      Store.setProgress(this.baseUrl, outside, inside);
    }

    async waitForExternalHandoff(timeout = 1200) {
      await Utils.sleep(timeout);
      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        this.shouldStop = true;
        this.panel.log('已交给新页面继续，返回目录页后会自动续跑');
        return true;
      }
      return false;
    }

    checkCompletionStatus(statusBox, statusText) {
      // 1. 百分比存在时只认 100%，1-99% 一律视为未完成
      const percentages = [...String(statusText || '').matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)]
        .map(match => Number(match[1]))
        .filter(value => Number.isFinite(value) && value >= 0 && value <= 100);
      if (percentages.length) return Math.max(...percentages) === 100;

      // 2. 检查明确的完成状态文本
      if (statusText.includes('已完成') || statusText.includes('已读')) {
        return true;
      }

      // 3. 检查明确的未完成状态文本
      if (statusText.includes('未开始') || statusText.includes('未读') || statusText.includes('进行中')) {
        return false;
      }

      // 4. 检查学习进度数字比例
      const progressMatch = statusText.match(/(\d+)\/(\d+)/);
      if (progressMatch) {
        const [, current, total] = progressMatch;
        const currentNum = parseInt(current, 10);
        const totalNum = parseInt(total, 10);

        // 根据数字进度判断：相等且大于0表示已完成
        return currentNum === totalNum && totalNum > 0;
      }

      // 默认返回false（未完成）
      return false;
    }

    async run() {
      this.panel.log(`检测到已播放到第 ${this.outside} 集，继续刷课...`);
      // 在课件页恢复时直接续播当前内容，不重新走列表流程
      if (location.pathname.includes('/studentCards/')) {
        const videoBox = document.querySelector('.video-box');
        const boxText = videoBox?.innerText || '';
        if ((videoBox || document.querySelector('video')) && !boxText.includes('已完成')) {
          this.panel.log('检测到当前课件页，直接续播当前内容');
          await this.waitCoursewareVideo();
          history.back();
          await Utils.sleep(1000);
        }
      }
      while (true) {
        await this.autoSlide();
        const list = document.querySelector('.logs-list')?.childNodes;
        if (!list || !list.length) {
          // 可能停留在课件页：跳回目录页继续，避免无限重试
          const pending = Store.getPendingAutoStart();
          const returnUrl = pending?.returnUrl
            || (pending?.classroomId ? `/v2/web/studentLog/${pending.classroomId}` : '');
          if (returnUrl && !location.pathname.includes('/studentLog/')) {
            this.panel.log('当前页面无课程列表，返回目录页继续');
            location.href = returnUrl;
            return;
          }
          this.panel.log('未找到课程列表，稍后重试');
          await Utils.sleep(2000);
          continue;
        }
        console.log(`当前集数:${this.outside}/全部集数${list.length}`);
        if (this.outside >= list.length) {
          this.panel.log('课程刷完啦 🎉');
          this.panel.resetStartButton('刷完啦~');
          Store.removeProgress(this.baseUrl);
          Store.clearPendingAutoStart();
          break;
        }
        const course = list[this.outside]?.querySelector('.content-box')?.querySelector('section');
        if (!course) {
          this.panel.log('未找到当前课程节点，跳过');
          this.updateProgress(this.outside + 1, 0);
          continue;
        }
        const type = course.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || 'piliang';
        const title = course.querySelector('h2')?.innerText?.trim() || `第${this.outside + 1}项`;

        // 预检查完成状态
        const statusBox = course.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';

        // 判断是否已完成
        let isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          this.updateProgress(this.outside + 1, 0);
          continue;
        }

        this.panel.log(`刷课状态：第 ${this.outside + 1}/${list.length} 个，类型 ${type}，标题：${title}`);
        if (type.includes('shipin')) {
          await this.handleVideo(course);
        } else if (type.includes('piliang')) {
          await this.handleBatch(course, list);
        } else if (type.includes('ketang')) {
          await this.handleClassroom(course);
        } else if (type.includes('kejian')) {
          await this.handleCourseware(course);
        } else if (type.includes('kaoshi')) {
          this.panel.log('考试区域脚本会被屏蔽，已跳过');
          this.updateProgress(this.outside + 1, 0);
        } else {
          this.panel.log('非视频/批量/课件/考试，已跳过');
          this.updateProgress(this.outside + 1, 0);
        }
        if (this.shouldStop) return;
      }
    }

    async autoSlide() {
      const frequency = Math.floor((this.outside + 1) / 20) + 1;
      for (let i = 0; i < frequency; i++) {
        Utils.scrollToBottom('.viewContainer');
        await Utils.sleep(800);
      }
    }

    async handleVideo(course) {
      course.click();
      if (await this.waitForExternalHandoff(1500)) return;
      await Utils.sleep(3000);
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      const title = document.querySelector('.title')?.innerText || '视频';
      const isDeadline = document.querySelector('.box')?.innerText.includes('已过考核截止时间');
      if (isDeadline) this.panel.log(`${title} 已过截止，进度不再增加，将直接跳过`);
      const video = document.querySelector('video');
      if (!isDeadline) {
        const rewindResult = await Player.rewindToStart(video);
        if (!rewindResult.success) {
          this.shouldStop = true;
          this.panel.warn(`${title} 未能重置到 0 秒，已停留当前页面`);
          return;
        }
        this.panel.log(`✅ ${title} 已从 0 秒重新播放（原位置 ${rewindResult.originalTime.toFixed(1)} 秒）`);
      }
      Player.applySpeed();
      Player.mute();
      const stopObserve = Player.observePause(video);
      const completed = await Utils.poll(() => {
        Utils.dismissPopups();
        return isDeadline || Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 5000, timeout: await Utils.getDDL(video) });
      stopObserve();
      if (!completed && !isDeadline) {
        this.shouldStop = true;
        this.panel.warn(`${title} 未确认播放完成，已停留当前页面，避免误跳转`);
        return;
      }
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1200);
    }

    async handleBatch(course, list) {
      const expandBtn = course.querySelector('.sub-info')?.querySelector('.gray')?.querySelector('span');
      if (!expandBtn) {
        this.panel.log('未找到批量展开按钮，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      expandBtn.click();
      await Utils.sleep(1200);
      const activities = list[this.outside]?.querySelector('.leaf_list__wrap')?.querySelectorAll('.activity__wrap') || [];
      let idx = this.inside;
      this.panel.log(`进入批量区，内部进度 ${idx}/${activities.length}`);
      while (idx < activities.length) {
        const item = activities[idx];
        if (!item) break;

        const tagText = item.querySelector('.tag')?.innerText || '';
        const tagHref = item.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || '';
        const title = item.querySelector('h2')?.innerText || `第${idx + 1}项`;

        // 检查当前项目的完成状态
        const statusBox = item.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';
        const isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          idx++;
          this.updateProgress(this.outside, idx);
          continue;
        }

        if (tagText === '音频') {
          idx = await this.playAudioItem(item, title, idx);
        } else if (tagHref.includes('shipin')) {
          idx = await this.playVideoItem(item, title, idx);
        } else if (tagHref.includes('tuwen') || tagHref.includes('taolun')) {
          idx = await this.autoCommentItem(item, tagHref.includes('tuwen') ? '图文' : '讨论', idx);
        } else if (tagHref.includes('zuoye')) {
          idx = await this.handleHomework(item, idx);
        } else {
          this.panel.log(`类型未知，已跳过：${title}`);
          idx++;
          this.updateProgress(this.outside, idx);
        }
        if (this.shouldStop) return;
      }
      this.updateProgress(this.outside + 1, 0);
      await Utils.sleep(1000);
    }

    async playAudioItem(item, title, idx) {
      this.panel.log(`开始播放音频：${title}`);
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Utils.sleep(2500);
      Player.applyMediaDefault(document.querySelector('audio'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      const completed = await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 3000, timeout: await Utils.getDDL() });
      if (!completed) {
        this.shouldStop = true;
        this.panel.warn(`${title} 未确认播放完成，已停留当前页面，避免误跳转`);
        return idx;
      }
      this.panel.log(`${title} 播放完成`);
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async playVideoItem(item, title, idx) {
      this.panel.log(`开始播放视频：${title}`);
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Utils.sleep(2500);
      const video = document.querySelector('video');
      const rewindResult = await Player.rewindToStart(video);
      if (!rewindResult.success) {
        this.shouldStop = true;
        this.panel.warn(`${title} 未能重置到 0 秒，已停留当前页面`);
        return idx;
      }
      this.panel.log(`✅ ${title} 已从 0 秒重新播放（原位置 ${rewindResult.originalTime.toFixed(1)} 秒）`);
      Player.applySpeed();
      Player.mute();
      const stopObserve = Player.observePause(video);
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      const completed = await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 3000, timeout: await Utils.getDDL(video) });
      stopObserve();
      if (!completed) {
        this.shouldStop = true;
        this.panel.warn(`${title} 未确认播放完成，已停留当前页面，避免误跳转`);
        return idx;
      }
      this.panel.log(`${title} 播放完成`);
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async autoCommentItem(item, typeText, idx) {
      this.panel.log(`开始处理${typeText}：${item.querySelector('h2')?.innerText || ''}`);
      item.click();
      await Utils.sleep(1200);

      // 检查是否开启自动评论功能
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoComment) {
        this.panel.log(`${typeText}已查看，但未开启自动回复功能`);
        idx++;
        this.updateProgress(this.outside, idx);
        history.back();
        await Utils.sleep(1000);
        return idx;
      }

      // 开启了自动评论功能，执行评论逻辑
      window.scrollTo(0, document.body.scrollHeight);
      await Utils.sleep(800);
      window.scrollTo(0, 0);
      const commentSelectors = ['#new_discuss .new_discuss_list .cont_detail', '.new_discuss_list dd .cont_detail', '.cont_detail.word-break'];
      let firstComment = '';
      for (let retry = 0; retry < 30 && !firstComment; retry++) {
        for (const sel of commentSelectors) {
          const list = document.querySelectorAll(sel);
          for (const node of list) {
            if (node?.innerText?.trim()) {
              firstComment = node.innerText.trim();
              break;
            }
          }
          if (firstComment) break;
        }
        if (!firstComment) await Utils.sleep(500);
      }
      if (!firstComment) {
        this.panel.log('未找到评论内容，跳过该项');
      } else {
        const input = document.querySelector('.el-textarea__inner');
        if (input) {
          input.value = firstComment;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await Utils.sleep(800);
          const sendBtn = document.querySelector('.el-button.submitComment') ||
            document.querySelector('.publish_discuss .postBtn button') ||
            document.querySelector('.el-button--primary');
          if (sendBtn && !sendBtn.disabled && !sendBtn.classList.contains('is-disabled')) {
            sendBtn.click();
            this.panel.log(`已在${typeText}区发表评论`);
          } else {
            this.panel.log('发送按钮不可用或不存在');
          }
        } else {
          this.panel.log('未找到评论输入框，跳过');
        }
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1000);
      return idx;
    }

    async handleHomework(item, idx) {
      const featureFlags = Store.getFeatureConf();
      const questionBank = Store.getQuestionBankConf();
      if (!featureFlags.autoAI && !questionBank.enabled) {
        this.panel.warn('请选择答题方式');
        idx++;
        this.updateProgress(this.outside, idx);
        return idx;
      }
      this.panel.log('进入作业，启动 OCR 自动答题');
      this.manualSubmitRequired = false;
      item.click();
      await Utils.sleep(1500);
      let i = 0;
      const maxRetry = 3; // 最大重试次数
      while (true) {
        const items = document.querySelectorAll('.subject-item.J_order');
        if (i >= items.length) {
          this.panel.log(`所有题目处理完毕，共 ${items.length} 题`);
          break;
        }
        const listItem = items[i];
        listItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        listItem.click();
        await Utils.sleep(1800);
        const disabled = document.querySelectorAll('.el-button.el-button--info.is-disabled.is-plain');
        if (disabled.length > 0) {
          this.panel.log(`第 ${i + 1} 题已完成，跳过...`);
          i++;
          continue;
        }
        const targetEl = document.querySelector('.item-type')?.parentElement || document.querySelector('.item-body');
        const decryption = await FontDecryptor.decryptRoot(targetEl);
        const domOptionCount = Solver.getOptionElements(targetEl).length;
        let ocrResult = decryption.decrypted ? Solver.buildDecryptedDOMText(targetEl) : '';
        if (ocrResult) {
          this.panel.log('🔓 已直接读取解密后的题目文本，跳过 OCR');
        } else {
          ocrResult = await Solver.recognize(targetEl);
        }
        if (ocrResult && ocrResult.length > 5) {
          const optionCount = domOptionCount || Solver.parseOptionsFromText(ocrResult).length;
          let retryCount = 0;
          let success = false;
          while (retryCount < maxRetry && !success) {
            try {
              if (retryCount > 0) {
                this.panel.log(`🔄 第 ${i + 1} 题重试 ${retryCount}/${maxRetry}...`);
              }
              panel.log('🔎 正在获取答案...');
              const resolvedAnswer = await Solver.resolveAnswer(targetEl, ocrResult, optionCount, {
                skipQuestionBank: retryCount > 0 && Store.getFeatureConf().autoAI
              });
              const selectionResult = await Solver.autoSelectAnswer(
                resolvedAnswer.answerText,
                targetEl,
                resolvedAnswer.answerStrings
              );
              const questionLabel = `第 ${i + 1} 题`;
              Solver.recordSelectionAudit(questionLabel, resolvedAnswer.source, selectionResult);
              success = Boolean(selectionResult?.selected);
              if (selectionResult?.requiresManualSubmit) this.manualSubmitRequired = true;
              if (success) {
                Solver.showAnswerSource(targetEl, questionLabel, resolvedAnswer.source);
                this.panel.log(`${resolvedAnswer.source === 'ITIHEY 题库' ? '📚' : '🤖'} ${questionLabel} · 答案来源：${resolvedAnswer.source}`);
              }
              if (success && this.manualSubmitRequired) {
                this.shouldStop = true;
                Store.clearPendingAutoStart();
                this.panel.warn('已停留当前题，请手动提交后点击继续');
                this.panel.resetStartButton('已提交，继续');
                return idx;
              }
              if (!success) {
                this.shouldStop = true;
                Store.clearPendingAutoStart();
                this.panel.warn(Solver.getSelectionFailureMessage(selectionResult));
                this.panel.resetStartButton('等待检查选项');
                return idx;
              }
            } catch (err) {
              if (Solver.isUngradedQuestion(targetEl)) {
                const questionLabel = `第 ${i + 1} 题`;
                const fallbackSource = '不计分题兜底';
                const fallbackResult = await Solver.selectAnyUngradedAnswer(targetEl);
                Solver.recordSelectionAudit(questionLabel, fallbackSource, fallbackResult);
                if (fallbackResult?.selected) {
                  if (fallbackResult.requiresManualSubmit) this.manualSubmitRequired = true;
                  Solver.showAnswerSource(targetEl, questionLabel, fallbackSource);
                  this.panel.log(`🗳️ ${questionLabel} · 题库未返回答案，已按不计分题任选一项`);
                  success = true;
                  break;
                }
              }
              this.shouldStop = true;
              Solver.waitForManualQuestion(targetEl?.closest('.container-problem') || targetEl?.parentElement || targetEl);
              Store.clearPendingAutoStart();
              this.panel.warn(`第 ${i + 1} 题未取得可用答案：${err.message || err}。已停止自动重试并停留当前题，请手动处理`);
              this.panel.resetStartButton('已提交，继续');
              return idx;
            }
          }
        }
        await Utils.sleep(1500);
        i++;
      }
      const answerFlow = Store.getFeatureConf();
      const shouldPause = this.manualSubmitRequired
        || (answerFlow.answerSubmitMode === 'save' && answerFlow.saveOnlyAction === 'manual');
      if (shouldPause) {
        this.shouldStop = true;
        const currentRoot = document.querySelector('.container-problem')
          || document.querySelector('.item-type')?.parentElement
          || document.querySelector('.item-body');
        Solver.waitForManualQuestion(currentRoot);
        Store.clearPendingAutoStart();
        this.panel.warn('本章题目已全部填写，现已停留页面，请检查后统一手动提交');
        this.panel.resetStartButton('已提交本章，继续');
        return idx;
      }
      idx++;
      this.updateProgress(this.outside, idx);
      if (answerFlow.answerSubmitMode === 'save') {
        this.panel.log('答案已保存，自动进入下一个课程');
      }
      history.back();
      await Utils.sleep(1200);
      return idx;
    }

    async handleClassroom(course) {
      this.panel.log('进入课堂模式...');
      course.click();
      await Utils.sleep(5000);
      const iframe = document.querySelector('iframe.lesson-report-mobile');
      if (!iframe || !iframe.contentDocument) {
        this.panel.log('未找到课堂 iframe，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      const video = iframe.contentDocument.querySelector('video');
      const audio = iframe.contentDocument.querySelector('audio');
      if (video) {
        const rewindResult = await Player.rewindToStart(video);
        if (!rewindResult.success) {
          this.shouldStop = true;
          this.panel.warn('课堂视频未能重置到 0 秒，已停留当前页面');
          return;
        }
        this.panel.log(`✅ 课堂视频已从 0 秒重新播放（原位置 ${rewindResult.originalTime.toFixed(1)} 秒）`);
        Player.applyMediaDefault(video);
        await Player.waitForEnd(video);
      }
      if (audio) {
        Player.applyMediaDefault(audio);
        await Player.waitForEnd(audio);
      }
      this.updateProgress(this.outside + 1, 0);
      history.go(-1);
      await Utils.sleep(1200);
    }

    // 等待课件视频播放完毕；播放器被关闭（弹窗关闭/元素销毁）时自动重新打开
    async waitCoursewareVideo() {
      const deadline = await Utils.getDDL();
      const start = Date.now();
      let boundVideo = null;
      let stopObserve = () => { };
      let reopenAttempts = 0;
      try {
        while (Date.now() - start < deadline) {
          Utils.dismissPopups();
          const video = document.querySelector('video');
          const display = document.querySelector('.xt_video_player_current_time_display');
          if (!video) {
            // 播放器被关闭或视频元素被销毁，重新打开视频框
            const videoBox = document.querySelector('.video-box');
            if (videoBox && !videoBox.innerText.includes('已完成')) {
              this.panel.log('播放器被关闭，正在重新打开');
              videoBox.click();
              boundVideo = null;
            }
            reopenAttempts++;
            if (reopenAttempts >= 4) {
              this.panel.log('播放器恢复失败，刷新页面重试');
              location.reload();
              return false;
            }
            await Utils.sleep(2000);
            continue;
          }
          reopenAttempts = 0;
          if (!display) {
            // 播放器加载中，等待渲染
            await Utils.sleep(800);
            continue;
          }
          if (video !== boundVideo) {
            stopObserve();
            const rewindResult = await Player.rewindToStart(video);
            if (!rewindResult.success) {
              this.panel.warn('课件视频未能重置到 0 秒，已停止当前轮次');
              return false;
            }
            this.panel.log(`✅ 课件视频已从 0 秒重新播放（原位置 ${rewindResult.originalTime.toFixed(1)} 秒）`);
            Player.applySpeed();
            Player.mute();
            boundVideo = video;
            stopObserve = Player.observePause(video);
          }
          const times = display.innerText || '';
          const [nowTime, totalTime] = times.split(' / ');
          if (nowTime && totalTime && nowTime === totalTime && AiWorkspace.isMediaAtPhysicalEnd(video)) return true;
          await Utils.sleep(800);
        }
        return false;
      } finally {
        stopObserve();
      }
    }

    async handleCourseware(course) {
      const tableData = course.parentNode?.parentNode?.parentNode?.__vue__?.tableData;
      const deadlinePassed = (tableData?.deadline || tableData?.end) ? (tableData.deadline < Date.now() || tableData.end < Date.now()) : false;
      if (deadlinePassed) {
        this.panel.log(`${course.querySelector('h2')?.innerText || '课件'} 已结课，跳过`);
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      course.click();
      await Utils.sleep(3000);

      // 检测"查看课件"按钮（课件概况页专用）
      const checkBtn = document.querySelector('.ppt_img_box .check') || document.querySelector('p.check');
      if (checkBtn && checkBtn.innerText?.trim() === '查看课件') {
        this.panel.log('检测到"查看课件"按钮，正在点击...');
        checkBtn.click();
        await Utils.sleep(2000);
      }
      const classType = document.querySelector('.el-card__header')?.innerText || '';
      const className = document.querySelector('.dialog-header')?.firstElementChild?.innerText || '课件';
      if (classType.includes('PPT')) {
        const slides = document.querySelector('.swiper-wrapper')?.children || [];
        this.panel.log(`开始播放 PPT：${className}`);
        for (let i = 0; i < slides.length; i++) {
          slides[i].click();
          this.panel.log(`${className}：第 ${i + 1} 张`);
          await Utils.sleep(Config.pptInterval);
        }
        await Utils.sleep(Config.pptInterval);
        const videoBoxes = document.querySelectorAll('.video-box');
        if (videoBoxes?.length) {
          this.panel.log('PPT 中有视频，继续播放');
          for (let i = 0; i < videoBoxes.length; i++) {
            if (videoBoxes[i].innerText === '已完成') {
              this.panel.log(`第 ${i + 1} 个视频已完成，跳过`);
              continue;
            }
            videoBoxes[i].click();
            await Utils.sleep(2000);
            await this.waitCoursewareVideo();
          }
        }
        this.panel.log(`${className} 已播放完毕`);
      } else {
        const videoBox = document.querySelector('.video-box');
        if (videoBox) {
          videoBox.click();
          await Utils.sleep(1800);
          await this.waitCoursewareVideo();
          this.panel.log(`${className} 视频播放完毕`);
        }
      }
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1000);
    }
  }

  // ---- pro/lms 旧版（仅做转发） ----
  class ProOldRunner {
    constructor(panel) {
      this.panel = panel;
    }
    run() {
      this.panel.log('准备打开新标签页...');
      const leafDetail = document.querySelectorAll('.leaf-detail');
      let classCount = Store.getProClassCount() - 1;
      while (leafDetail[classCount] && !leafDetail[classCount].firstChild.querySelector('i').className.includes('shipin')) {
        classCount++;
        Store.setProClassCount(classCount + 1);
        this.panel.log('课程不属于视频，已跳过');
      }
      leafDetail[classCount]?.click();
    }
  }

  // ---- pro/lms 新版（主要逻辑） ----
  class ProNewRunner {
    constructor(panel) {
      this.panel = panel;
    }
    async run() {
      preventScreenCheck();
      let classCount = Store.getProClassCount();
      while (true) {
        this.panel.log(`准备播放第 ${classCount} 集...`);
        await Utils.sleep(2000);
        const className = document.querySelector('.header-bar')?.firstElementChild?.innerText || '';
        const classType = document.querySelector('.header-bar')?.firstElementChild?.firstElementChild?.getAttribute('class') || '';
        const classStatus = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
        if (classType.includes('tuwen') && !classStatus.includes('已读')) {
          this.panel.log(`正在阅读：${className}`);
          await Utils.sleep(2000);
        } else if (classType.includes('taolun')) {
          this.panel.log(`讨论区暂不自动发帖，${className}`);
          await Utils.sleep(2000);
        } else if (classType.includes('shipin') && !Utils.isProgressDone(classStatus)) {
          this.panel.log(`2s 后开始播放：${className}`);
          await Utils.sleep(2000);
          let statusTimer;
          let videoCompleted = false;
          let stopObserve = () => { };
          try {
            statusTimer = setInterval(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              if (Utils.isProgressDone(status)) {
                this.panel.log(`${className} 播放完毕`);
                clearInterval(statusTimer);
                statusTimer = null;
              }
            }, 200);

            const videoReady = await Utils.poll(
              () => Boolean(document.querySelector('video')),
              { interval: 500, timeout: 20000 }
            );
            const video = document.querySelector('video');
            if (!videoReady || !video) {
              this.panel.warn(`${className} 未找到视频元素，已停留当前页面`);
              this.panel.resetStartButton('重新检查当前视频');
              return;
            }
            const rewindResult = await Player.rewindToStart(video);
            if (!rewindResult.success) {
              this.panel.warn(`${className} 未能重置到 0 秒，已停留当前页面`);
              this.panel.resetStartButton('重新检查当前视频');
              return;
            }
            this.panel.log(`✅ ${className} 已从 0 秒重新播放（原位置 ${rewindResult.originalTime.toFixed(1)} 秒）`);
            Player.applySpeed();
            Player.mute();
            stopObserve = Player.observePause(video);

            await Utils.sleep(8000);
            videoCompleted = await Utils.poll(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              return Utils.isProgressDone(status);
            }, { interval: 1000, timeout: await Utils.getDDL(video) });
          } finally {
            if (statusTimer) clearInterval(statusTimer);
            stopObserve();
          }
          if (!videoCompleted) {
            this.panel.warn(`${className} 未确认播放完成，已停留当前页面，避免误跳转`);
            this.panel.resetStartButton('重新检查当前视频');
            return;
          }
        } else if (classType.includes('zuoye')) {
          this.panel.log(`进入作业：${className}（暂无自动答题）`);
          await Utils.sleep(2000);
        } else if (classType.includes('kaoshi')) {
          this.panel.log(`进入考试：${className}（不会自动答题）`);
          await Utils.sleep(2000);
        } else if (classType.includes('ketang')) {
          this.panel.log(`进入课堂：${className}（暂无自动功能）`);
          await Utils.sleep(2000);
        } else {
          this.panel.log(`已看过：${className}`);
          await Utils.sleep(2000);
        }
        this.panel.log(`第 ${classCount} 集播放完毕`);
        classCount++;
        Store.setProClassCount(classCount);
        const nextBtn = document.querySelector('.btn-next');
        if (nextBtn) {
          const event1 = new Event('mousemove', { bubbles: true });
          event1.clientX = 9999;
          event1.clientY = 9999;
          nextBtn.dispatchEvent(event1);
          nextBtn.dispatchEvent(new Event('click'));
        } else {
          localStorage.removeItem(Config.storageKeys.proClassCount);
          this.panel.log('课程播放完毕 🎉');
          Store.clearPendingAutoStart();
          this.panel.resetStartButton('开始刷课');
          break;
        }
      }
    }
  }

  // ---- ai-workspace 新版学习空间 ----
  class AiWorkspaceRunner {
    constructor(panel) {
      this.panel = panel;
      this.manualSubmitRequired = false;
      this.detectedQuestionCount = 0;
    }

    getExerciseQuestionLabel(root) {
      const tabs = AiWorkspace.getExerciseQuestionTabs(root);
      const active = tabs.find(tab => /active|current|selected|is-active/.test(tab.className));
      return AiWorkspace.normalizeText(active?.innerText || '');
    }

    // 获取要跳转回去的目标地址
    getReturnUrl() {
      const pending = Store.getPendingAutoStart();
      const route = AiWorkspace.getRoute();
      if (!pending || !route) return '';
      if (pending.classroomId !== route.classroomId) return '';
      console.log(`returnUrl:${pending.returnUrl}`)
      return pending.returnUrl || '';
    }

    async autoSelect() {
      // 进入ai - workspace的方式有两种：可以处理两种不同的逻辑，增加兼容性
      const returnUrl = this.getReturnUrl()
      // 1. 从传统的 v2 - pro / lms 的目录新开标签页进入（开始刷课）的
      if (returnUrl) {
        await this.returnToSource(returnUrl)
      } else {
        // 2. 直接从ai - workspac页面进入（开始刷课）的
        this.panel.log("检测到是从ai - workspac页面点击开始刷课");
        this.source = AiWorkspace.getAllScourse(); // 得到课程列表
        this.activateIndex = AiWorkspace.getActiveCourseIndex(this.source); // 现在正在刷第几个（从0开始）
        if (this.activateIndex < 0) {
          this.panel.warn('未能可靠定位当前章节，为避免跳错章节，已停止自动跳转');
          this.panel.resetStartButton('重新定位当前章节');
          return false;
        }
        await this.handleNext(this.activateIndex + 1)
      }
    }

    // 获取父窗口对象 window.opener
    getSourceWindow() {
      try {
        if (!window.opener || window.opener.closed) return null;
        if (window.opener.location.origin !== location.origin) return null;
        return window.opener;
      } catch (_) {
        return null;
      }
    }

    async returnToSource(returnUrl) {
      this.panel.log('媒体播放完成，返回课程目录页继续匹配');
      await Utils.sleep(1200);
      const sourceWindow = this.getSourceWindow();
      console.log(sourceWindow);
      if (sourceWindow) {
        try {
          sourceWindow.location.href = returnUrl;
          sourceWindow.focus();
          window.close();
          return true;
        } catch (e) {
          console.error("跳转父窗口异常", e);
        }
      }
      // if (location.href !== returnUrl) {
      //   location.href = returnUrl;
      // } else {
      //   history.back();
      // }
      // return true;
    }

    async handleMedia(route) {
      const title = AiWorkspace.getActiveLeafTitle() || `${route.type} ${route.leafId}`;
      let completionBeforePlayback = AiWorkspace.getActiveLeafCompletion();
      if (route.type === 'video' && !completionBeforePlayback.isCompleted && completionBeforePlayback.percent === null) {
        await Utils.poll(() => {
          const latest = AiWorkspace.getActiveLeafCompletion();
          completionBeforePlayback = latest;
          return latest.isCompleted || latest.percent !== null;
        }, { interval: 300, timeout: 3000 });
      }
      if (route.type === 'video' && completionBeforePlayback.isCompleted) {
        AiWorkspace.lastMediaPlayback = {
          title,
          route: { ...route },
          startedAt: new Date().toISOString(),
          skipped: true,
          completionBeforePlayback,
          completionReason: 'already-completed-100-percent'
        };
        AiWorkspace.persistMediaPlayback(true);
        this.panel.log(`✅ ${title} 完成度为 100%，已跳过`);
        return true;
      }
      if (route.type === 'video') {
        const progressLabel = completionBeforePlayback.percent === null
          ? '未识别到 100% 完成标记'
          : `当前完成度 ${completionBeforePlayback.percent}%`;
        this.panel.log(`${progressLabel}，将从 0 秒完整播放`);
      }
      this.panel.log(`开始播放：${title}`);
      const ready = await Utils.poll(() => Boolean(AiWorkspace.getMedia(route.type)), { interval: 500, timeout: 20000 });
      const media = AiWorkspace.getMedia(route.type);
      if (!ready || !media) {
        this.panel.log('未找到视频/音频元素，停止当前轮次');
        return false;
      }

      const playbackState = {
        completed: false,
        completionReason: '',
        invalidReason: '',
        nearEndChecks: 0,
        prematureEndedEvents: 0
      };
      const candidateIndex = AiWorkspace.getMediaCandidates().indexOf(media);
      AiWorkspace.lastMediaPlayback = {
        title,
        route: { ...route },
        startedAt: new Date().toISOString(),
        lockedCandidateIndex: candidateIndex,
        initialState: AiWorkspace.snapshotMedia(media, candidateIndex),
        completionBeforePlayback,
        rewind: null,
        confirmedStartState: null,
        finalState: null,
        completionReason: '',
        invalidReason: '',
        nearEndChecks: 0,
        prematureEndedEvents: 0
      };
      AiWorkspace.persistMediaPlayback();

      if (route.type === 'video') {
        this.panel.log('正在将视频进度重置到开头...');
        const rewindResult = await Player.rewindToStart(media);
        AiWorkspace.lastMediaPlayback.rewind = rewindResult;
        AiWorkspace.lastMediaPlayback.rewindState = AiWorkspace.snapshotMedia(media, candidateIndex);
        AiWorkspace.persistMediaPlayback();
        if (!rewindResult.success) {
          AiWorkspace.lastMediaPlayback.invalidReason = `rewind-failed: ${rewindResult.reason}`;
          AiWorkspace.lastMediaPlayback.finalState = AiWorkspace.snapshotMedia(media, candidateIndex);
          AiWorkspace.persistMediaPlayback(true);
          this.panel.warn('未能把视频稳定重置到 0 秒，已停留当前页面，不会从续播位置开始');
          return false;
        }
        this.panel.log(`✅ 已从 0 秒重新播放（原位置 ${rewindResult.originalTime.toFixed(1)} 秒）`);
      }

      const shouldResume = () => !playbackState.completed;
      let stopObserve = () => { };
      if (media.tagName.toLowerCase() === 'video') {
        Player.applySpeed();
        Player.mute();
        stopObserve = Player.observePause(media, shouldResume);
      }
      Player.applyMediaDefault(media);
      const stopKeepAlive = AiWorkspace.keepAlive(shouldResume, media);
      this.panel.log(`已接管播放器：${media.tagName.toLowerCase()}，目标倍速 ${Config.playbackRate}x，静音开启`);
      try {
        const initialTime = Number(media.currentTime || 0);
        const startCheckAt = Date.now();
        let unexpectedStartSeek = false;
        const started = await Utils.poll(() => {
          const currentTime = Number(media.currentTime || 0);
          const elapsedSeconds = (Date.now() - startCheckAt) / 1000;
          const plausibleAdvance = elapsedSeconds * Math.max(1, Number(media.playbackRate || Config.playbackRate)) * 1.5 + 3;
          if (route.type === 'video' && currentTime > initialTime + plausibleAdvance) {
            unexpectedStartSeek = true;
            return true;
          }
          return media.isConnected
            && (currentTime > initialTime + 0.5
              || (!media.paused && media.readyState >= 2 && currentTime > initialTime + 0.2));
        }, { interval: 500, timeout: 15000 });
        if (unexpectedStartSeek) {
          AiWorkspace.lastMediaPlayback.invalidReason = 'resume-position-restored-after-play';
          AiWorkspace.lastMediaPlayback.finalState = AiWorkspace.snapshotMedia(media, candidateIndex);
          AiWorkspace.persistMediaPlayback(true);
          this.panel.warn('开始播放后页面又恢复到了旧进度，已停止并停留当前页，避免漏计时长');
          return false;
        }
        if (!started) {
          AiWorkspace.lastMediaPlayback.invalidReason = 'locked-media-did-not-start';
          AiWorkspace.lastMediaPlayback.finalState = AiWorkspace.snapshotMedia(media, candidateIndex);
          AiWorkspace.persistMediaPlayback(true);
          this.panel.log('未确认到视频实际开始播放，停止当前轮次');
          return false;
        }
        const startTime = Number(media.currentTime || 0);
        const expectedSource = media.currentSrc || media.getAttribute?.('src') || '';
        AiWorkspace.lastMediaPlayback.confirmedStartState = AiWorkspace.snapshotMedia(media, candidateIndex);
        AiWorkspace.persistMediaPlayback();

        let resolveEnded;
        const endedPromise = new Promise(resolve => {
          resolveEnded = resolve;
        });
        const onEnded = () => {
          const currentRoute = AiWorkspace.getRoute();
          const currentSource = media.currentSrc || media.getAttribute?.('src') || '';
          if (!currentRoute || currentRoute.leafId !== route.leafId || currentRoute.type !== route.type) {
            playbackState.invalidReason = 'route-changed-before-ended';
            resolveEnded(false);
            return;
          }
          if (expectedSource && currentSource && currentSource !== expectedSource) {
            playbackState.invalidReason = 'media-source-changed-before-ended';
            resolveEnded(false);
            return;
          }
          if (!AiWorkspace.isMediaAtPhysicalEnd(media)) {
            playbackState.prematureEndedEvents++;
            AiWorkspace.lastMediaPlayback.prematureEndedEvents = playbackState.prematureEndedEvents;
            AiWorkspace.lastMediaPlayback.lastPrematureEndedState = AiWorkspace.snapshotMedia(media, candidateIndex);
            AiWorkspace.persistMediaPlayback();
            const remaining = Math.max(0, Number(media.duration || 0) - Number(media.currentTime || 0));
            this.panel.warn(`播放器提前触发 ended（尚余 ${remaining.toFixed(1)} 秒），已忽略，不会跳转`);
            media.play().catch(() => { });
            return;
          }
          playbackState.completed = true;
          playbackState.completionReason = 'ended-event';
          resolveEnded(true);
        };
        media.addEventListener('ended', onEnded);
        const done = await Promise.race([
          endedPromise,
          Utils.poll(() => {
            if (playbackState.completed) return true;
            const currentRoute = AiWorkspace.getRoute();
            if (!currentRoute || currentRoute.leafId !== route.leafId || currentRoute.type !== route.type) {
              playbackState.invalidReason = 'route-changed-during-playback';
              return true;
            }
            if (!media.isConnected) {
              playbackState.invalidReason = 'locked-media-disconnected';
              return true;
            }
            const currentSource = media.currentSrc || media.getAttribute?.('src') || '';
            if (expectedSource && currentSource && currentSource !== expectedSource) {
              playbackState.invalidReason = 'locked-media-source-changed';
              return true;
            }
            const reason = AiWorkspace.getPlayerCompletionReason(media, {
              startTime,
              minPlayedDelta: 3,
              expectedSource
            });
            if (reason === 'premature-ended-state') {
              if (!playbackState.prematureEndedEvents) {
                playbackState.prematureEndedEvents = 1;
                AiWorkspace.lastMediaPlayback.prematureEndedEvents = 1;
                AiWorkspace.lastMediaPlayback.lastPrematureEndedState = AiWorkspace.snapshotMedia(media, candidateIndex);
                AiWorkspace.persistMediaPlayback();
                const remaining = Math.max(0, Number(media.duration || 0) - Number(media.currentTime || 0));
                this.panel.warn(`检测到视频提前结束状态（尚余 ${remaining.toFixed(1)} 秒），已忽略，不会跳转`);
              }
              media.play().catch(() => { });
              return false;
            }
            if (reason === 'near-end') {
              playbackState.nearEndChecks++;
              if (playbackState.nearEndChecks < 3) return false;
              playbackState.completionReason = 'near-end-confirmed-3-times';
              playbackState.completed = true;
              return true;
            }
            playbackState.nearEndChecks = 0;
            if (reason === 'media-ended-state') {
              playbackState.completionReason = reason;
              playbackState.completed = true;
              return true;
            }
            return false;
          }, { interval: 1000, timeout: await Utils.getDDL(media) })
        ]);
        media.removeEventListener('ended', onEnded);
        AiWorkspace.lastMediaPlayback.finalState = AiWorkspace.snapshotMedia(media, candidateIndex);
        AiWorkspace.lastMediaPlayback.completionReason = playbackState.completionReason;
        AiWorkspace.lastMediaPlayback.invalidReason = playbackState.invalidReason;
        AiWorkspace.lastMediaPlayback.nearEndChecks = playbackState.nearEndChecks;
        AiWorkspace.lastMediaPlayback.prematureEndedEvents = playbackState.prematureEndedEvents;
        AiWorkspace.persistMediaPlayback(true);
        if (playbackState.invalidReason) {
          this.panel.log(`播放器状态已变化（${playbackState.invalidReason}），为防止误跳转已停止当前轮次`);
          return false;
        }
        if (!done || !playbackState.completed) {
          this.panel.log('等待播放完成超时，停止当前轮次');
          return false;
        }
      } finally {
        stopObserve();
        stopKeepAlive();
      }

      this.panel.log(`${title} 播放完成（${playbackState.completionReason || '已确认'}）`);
      return true;
    }

    async solveExerciseQuestion(root, label = '') {
      const questionRoot = AiWorkspace.getExerciseQuestionBody(root);
      if (!questionRoot) {
        this.panel.log('未找到题目容器，停止当前轮次');
        return false;
      }
      if (AiWorkspace.isExerciseAnswered(root)) {
        this.panel.log(`${label || '当前题目'} 已完成，跳过`);
        return true;
      }

      const decryption = await FontDecryptor.decryptRoot(questionRoot);
      const domOptionCount = Solver.getOptionElements(questionRoot).length;

      let ocrResult = decryption.decrypted ? Solver.buildDecryptedDOMText(questionRoot) : '';
      if (ocrResult) {
        this.panel.log('🔓 已直接读取解密后的题目文本，跳过 OCR');
      } else {
        ocrResult = await Solver.recognize(questionRoot);
      }
      if (!ocrResult || ocrResult.length <= 5) {
        this.panel.log(`${label || '当前题目'} OCR 结果过短，跳过`);
        return false;
      }
      const optionCount = domOptionCount || Solver.parseOptionsFromText(ocrResult).length;
      const maxRetry = 3;
      for (let retryCount = 0; retryCount < maxRetry; retryCount++) {
        try {
          if (retryCount > 0) this.panel.log(`${label || '当前题目'} 重试 ${retryCount}/${maxRetry - 1}`);
          this.panel.log('🔎 正在获取答案...');
          const resolvedAnswer = await Solver.resolveAnswer(questionRoot, ocrResult, optionCount, {
            skipQuestionBank: retryCount > 0 && Store.getFeatureConf().autoAI
          });
          const selectionResult = await Solver.autoSelectAnswer(
            resolvedAnswer.answerText,
            questionRoot,
            resolvedAnswer.answerStrings
          );
          const questionLabel = label || '当前题目';
          Solver.recordSelectionAudit(questionLabel, resolvedAnswer.source, selectionResult);
          if (!selectionResult?.selected) {
            this.manualSubmitRequired = true;
            Store.clearPendingAutoStart();
            this.panel.warn(Solver.getSelectionFailureMessage(selectionResult));
            return false;
          }
          if (selectionResult.requiresManualSubmit) this.manualSubmitRequired = true;
          Solver.showAnswerSource(questionRoot, questionLabel, resolvedAnswer.source);
          this.panel.log(`${resolvedAnswer.source === 'ITIHEY 题库' ? '📚' : '🤖'} ${questionLabel} · 答案来源：${resolvedAnswer.source}`);
          await Utils.sleep(1200);
          return true;
        } catch (err) {
          if (Solver.isUngradedQuestion(questionRoot)) {
            const questionLabel = label || '当前题目';
            const fallbackSource = '不计分题兜底';
            const fallbackResult = await Solver.selectAnyUngradedAnswer(questionRoot);
            Solver.recordSelectionAudit(questionLabel, fallbackSource, fallbackResult);
            if (fallbackResult?.selected) {
              if (fallbackResult.requiresManualSubmit) this.manualSubmitRequired = true;
              Solver.showAnswerSource(questionRoot, questionLabel, fallbackSource);
              this.panel.log(`🗳️ ${questionLabel} · 题库未返回答案，已按不计分题任选一项`);
              await Utils.sleep(500);
              return true;
            }
          }
          this.manualSubmitRequired = true;
          Solver.waitForManualQuestion(root);
          Store.clearPendingAutoStart();
          this.panel.warn(`${label || '当前题目'} 未取得可用答案：${err.message || err}。已停止自动重试并停留当前题，请手动处理`);
          return false;
        }
      }
      return false;
    }

    async advanceExerciseQuestion(root, previousFingerprint = '') {
      const currentRoot = AiWorkspace.getExerciseContainer() || root;
      const nextBtn = AiWorkspace.getExerciseActionButton(currentRoot, /下一题|下一道|下一步/);
      if (!nextBtn) return false;
      const disabled = Boolean(
        nextBtn.disabled
        || nextBtn.getAttribute('disabled') !== null
        || nextBtn.getAttribute('aria-disabled') === 'true'
        || nextBtn.classList.contains('is-disabled')
        || nextBtn.classList.contains('disabled')
      );
      if (disabled) return false;
      nextBtn.click();
      return Utils.poll(() => {
        const latestRoot = AiWorkspace.getExerciseContainer() || currentRoot;
        const questionRoot = AiWorkspace.getExerciseQuestionBody(latestRoot);
        const fingerprint = Solver.questionFingerprint(questionRoot);
        return fingerprint && fingerprint !== previousFingerprint;
      }, { interval: 500, timeout: 5000 });
    }

    async handleExercise(route) {
      const featureFlags = Store.getFeatureConf();
      const questionBank = Store.getQuestionBankConf();
      if (!featureFlags.autoAI && !questionBank.enabled) {
        this.panel.warn('请选择答题方式');
        this.panel.resetStartButton('请选择答题方式');
        return 'paused';
      }

      const ready = await Utils.poll(() => Boolean(AiWorkspace.getExerciseContainer()), { interval: 500, timeout: 20000 });
      const root = AiWorkspace.getExerciseContainer();
      if (!ready || !root) {
        this.panel.log('未找到作业容器，停止当前轮次');
        return false;
      }

      this.manualSubmitRequired = false;
      Solver.ensureAnswerSourceObserver();
      Solver.restoreAnswerSources(root);
      this.panel.log(`开始处理作业：${AiWorkspace.getActiveLeafTitle() || route.leafId}`);
      const tabs = AiWorkspace.getExerciseQuestionTabs(root);
      if (tabs.length) {
        this.detectedQuestionCount = tabs.length;
        Store.trimAnswerSources(Solver.getAnswerSourceScope(), tabs.length);
        this.panel.log(`检测到题目索引 ${tabs.length} 个，按题号顺序作答`);
        for (let i = 0; i < tabs.length; i++) {
          const currentRoot = AiWorkspace.getExerciseContainer() || root;
          const currentTabs = AiWorkspace.getExerciseQuestionTabs(currentRoot);
          const currentTab = currentTabs[i];
          if (!currentTab) break;
          currentTab.click();
          await Utils.sleep(1200);
          const latestRoot = AiWorkspace.getExerciseContainer() || currentRoot;
          Solver.restoreAnswerSources(latestRoot);
          await this.solveExerciseQuestion(latestRoot, `第 ${i + 1} 题`);
          if (this.manualSubmitRequired) return this.finishExerciseFlow();
        }
        return this.finishExerciseFlow();
      }

      this.panel.log('未找到题号列表，尝试只处理当前题并按下一题推进');
      const seenFingerprints = new Set();
      for (let i = 0; i < 200; i++) {
        const currentRoot = AiWorkspace.getExerciseContainer() || root;
        const questionRoot = AiWorkspace.getExerciseQuestionBody(currentRoot);
        const fingerprint = Solver.questionFingerprint(questionRoot);
        if (!fingerprint) break;
        if (seenFingerprints.has(fingerprint)) break;
        seenFingerprints.add(fingerprint);
        const actualQuestionNumber = Solver.getQuestionNumberFromRoot(questionRoot) || i + 1;
        this.detectedQuestionCount = Math.max(this.detectedQuestionCount, actualQuestionNumber);
        Solver.restoreAnswerSources(currentRoot);
        await this.solveExerciseQuestion(currentRoot, `第 ${actualQuestionNumber} 题`);
        if (this.manualSubmitRequired) return this.finishExerciseFlow();
        const moved = await this.advanceExerciseQuestion(currentRoot, fingerprint);
        if (!moved) break;
      }
      Store.trimAnswerSources(Solver.getAnswerSourceScope(), this.detectedQuestionCount);
      return this.finishExerciseFlow();
    }

    finishExerciseFlow() {
      const answerFlow = Store.getFeatureConf();
      const shouldPause = this.manualSubmitRequired
        || (answerFlow.answerSubmitMode === 'save' && answerFlow.saveOnlyAction === 'manual');
      if (shouldPause) {
        const currentRoot = AiWorkspace.getExerciseContainer();
        Solver.restoreAnswerSources(currentRoot);
        Solver.waitForManualQuestion(currentRoot);
        if (this.manualSubmitRequired) {
          Store.clearPendingAutoStart();
          this.panel.warn('本章存在未能自动完成的题目，已停留页面，请检查处理');
          this.panel.resetStartButton('处理完成，继续');
        } else {
          this.panel.warn('本章题目已全部填写，现已停留页面，请检查每题来源后统一手动提交');
          this.panel.resetStartButton('已提交本章，继续');
        }
        return 'paused';
      }
      if (answerFlow.answerSubmitMode === 'save') {
        this.panel.log('答案已保存，自动进入下一个课程');
      } else {
        this.panel.log('答案已自动提交，继续下一个课程');
      }
      return true;
    }

    // 直接在ai-workspace页面处理课程的逻辑
    async handleNext(count) {
      if (count >= this.source.length) {
        this.panel.log('课程刷完啦 🎉');
        this.panel.resetStartButton('刷完啦~');
        Store.clearPendingAutoStart();
        return;
      }
      const target = this.source[count];
      const clickable = target.querySelector?.('.leaf-item, [role="button"], a, button')
        || target.firstElementChild
        || target;
      clickable.click();
      await Utils.sleep(2000);
      await this.run(false)
    }

    async run(preventScreenCheckSwitch = true) {
      // 仅开启一次防切屏
      if (preventScreenCheckSwitch) preventScreenCheck();
      const route = AiWorkspace.getRoute();
      if (!route) {
        this.panel.log('当前页面已离开 ai-workspace/lms-graph');
        return;
      }
      if (!route.leafId) {
        this.panel.log('未能识别当前知识点');
        return;
      }
      let ok = false;
      if (route.type === 'video' || route.type === 'audio') {
        ok = await this.handleMedia(route);
      } else if (route.type === 'exercise') {
        const exerciseResult = await this.handleExercise(route);
        if (exerciseResult === 'paused') return;
        ok = exerciseResult;
      } else {
        this.panel.log(`当前类型为 ${route.type}，当前暂不自动处理此类型，自动跳过`);
        await Utils.sleep(2000);
        ok = true;
      }
      if (!ok) {
        this.panel.warn('未能确认当前内容已经完成，已停留本页，不会自动跳到下一个');
        this.panel.resetStartButton('重新检查当前内容');
        return;
      }
      // 当前内容已确认完成，继续下一个
      await this.autoSelect()
    }
  }

  // ---- 路由 ----
  function start() {
    const pendingQuestion = Solver.pendingManualQuestion;
    const currentQuestion = AiWorkspace.getExerciseContainer() || pendingQuestion;
    if (pendingQuestion) {
      const chapterSubmitted = AiWorkspace.isExerciseAnswered(currentQuestion);
      if (!chapterSubmitted) {
        panel.warn('尚未检测到本章提交完成，请先手动提交整章答案');
        panel.resetStartButton('已提交本章，继续');
        return;
      }
      panel.log('✅ 已检测到本章提交完成，正在进入下一章');
      Solver.pendingManualQuestion = null;
      Solver.pendingManualIdentity = '';
      const route = AiWorkspace.getRoute();
      if (route?.type === 'exercise') {
        panel.resetStartButton('正在进入下一章...');
        return new AiWorkspaceRunner(panel).autoSelect();
      }
    }
    Solver.pendingManualQuestion = null;
    Solver.pendingManualIdentity = '';
    const featureFlags = Store.getFeatureConf();
    const questionBank = Store.getQuestionBankConf();
    if (!featureFlags.autoAI && !questionBank.enabled) {
      panel.warn('请选择答题方式');
    }
    // ---- ai-workspace获取课程根目录信息并保存（处理完一个课程重定向到根目录） ----
    const classroomId = Utils.getCurrentClassroomId();
    const returnUrl = Utils.returnUrl()
    Store.setPendingAutoStart(classroomId, returnUrl);
    const aiRoute = AiWorkspace.getRoute();
    if (aiRoute) {
      panel.log(`正在匹配处理逻辑：ai-workspace/lms-graph/${aiRoute.type}`);
      return new AiWorkspaceRunner(panel).run();
    }
    // ---- ai-workspace end
    const url = location.host;
    const path = location.pathname.split('/');
    const matchURL = `${url}${path[0]}/${path[1]}/${path[2]}`;
    panel.log(`正在匹配处理逻辑：${matchURL}`);
    if (matchURL.includes('yuketang.cn/v2/web') || matchURL.includes('gdufemooc.cn/v2/web')) {
      return new V2Runner(panel).run();
    } else if (matchURL.includes('yuketang.cn/pro/lms') || matchURL.includes('gdufemooc.cn/pro/lms')) {
      if (document.querySelector('.btn-next')) {
        return new ProNewRunner(panel).run();
      } else {
        return new ProOldRunner(panel).run();
      }
    } else {
      panel.resetStartButton('开始刷课');
      panel.log('当前页面非刷课页面，应匹配 */v2/web/*、*/pro/lms/* 或 */ai-workspace/lms-graph/*');
    }
  }

  // ---- 启动 ----
  async function boot() {
    if (Utils.inIframe()) return;
    await Utils.waitForMountTarget();
    try {
      panel = createPanel();
      panel.log(`🧪 雨课堂高校版刷课脚本（测试版）v${Config.version} 已加载`);
      panel.setStartHandler(start);
      const pendingAutoStart = Store.getPendingAutoStart();
      const currentClassroomId = Utils.getCurrentClassroomId();
      if (
        pendingAutoStart
        && Utils.isSupportedLearningPage()
        && currentClassroomId
        && pendingAutoStart.classroomId === currentClassroomId
      ) {
        panel.log(`检测到跨页面跳转，自动恢复刷课：课堂 ${currentClassroomId}`);
        setTimeout(() => panel.start(), 1200);
      }
    } catch (err) {
      console.error('面板初始化失败:', err);
    }
  }

  boot();

})();
