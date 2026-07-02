const state = {
  questions: [],
  answers: {},
  index: 0,
  startAt: 0,
  timerId: null,
};

const els = {
  fileInput: document.getElementById("fileInput"),
  parseBtn: document.getElementById("parseBtn"),
  loadDemoBtn: document.getElementById("loadDemoBtn"),
  parseHint: document.getElementById("parseHint"),
  quizPanel: document.getElementById("quizPanel"),
  resultPanel: document.getElementById("resultPanel"),
  questionBox: document.getElementById("questionBox"),
  progressText: document.getElementById("progressText"),
  timerText: document.getElementById("timerText"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  submitBtn: document.getElementById("submitBtn"),
  retryBtn: document.getElementById("retryBtn"),
  scoreText: document.getElementById("scoreText"),
  resultList: document.getElementById("resultList"),
};

const TYPE_MAP = {
  single: "单选题",
  multiple: "多选题",
  judge: "判断题",
  blank: "填空题",
  essay: "大题",
};

const demoBank = [
  {
    id: "d1",
    type: "single",
    stem: "HTML 中用于创建超链接的标签是？",
    options: ["<a>", "<div>", "<p>", "<link>"],
    answer: ["A"],
    score: 2,
    explanation: "<a> 标签定义超链接。",
  },
  {
    id: "d2",
    type: "judge",
    stem: "CSS 可以用于控制网页布局和样式。",
    answer: ["T"],
    score: 2,
    explanation: "判断题，正确。",
  },
  {
    id: "d3",
    type: "blank",
    stem: "JavaScript 中声明常量使用关键字 ____ 。",
    answer: ["const"],
    score: 3,
    explanation: "常量用 const 声明。",
  },
  {
    id: "d4",
    type: "essay",
    stem: "简述响应式布局的常见实现方式。",
    answer: ["示例答案"],
    score: 8,
    explanation: "大题默认不自动判分，展示参考答案。",
  },
];

els.parseBtn.addEventListener("click", parseFilesAndStart);
els.loadDemoBtn.addEventListener("click", () => initQuiz(structuredClone(demoBank)));
els.prevBtn.addEventListener("click", () => switchQuestion(-1));
els.nextBtn.addEventListener("click", () => switchQuestion(1));
els.submitBtn.addEventListener("click", submitQuiz);
els.retryBtn.addEventListener("click", retryQuiz);

async function parseFilesAndStart() {
  const files = Array.from(els.fileInput.files || []);
  if (!files.length) {
    els.parseHint.textContent = "请先选择题库文件";
    return;
  }

  let allQuestions = [];
  for (const file of files) {
    const ext = file.name.split(".").pop().toLowerCase();
    const questions = await parseQuestionFile(file, ext);
    allQuestions = allQuestions.concat(questions);
  }

  if (!allQuestions.length) {
    els.parseHint.textContent = "未识别到题目，请检查题库格式（见 README）";
    return;
  }

  allQuestions = normalizeQuestions(allQuestions);
  initQuiz(allQuestions);
}

async function parseQuestionFile(file, ext) {
  if (ext === "json") {
    const text = await file.text();
    return parseJsonBank(text);
  }

  if (ext === "txt" || ext === "md") {
    const text = await file.text();
    return parseTextBank(text);
  }

  if (ext === "doc" || ext === "docx") {
    const text = await extractOfficeText(file);
    return parseTextBank(text);
  }

  const fallbackText = await file.text();
  return parseTextBank(fallbackText);
}

function parseJsonBank(text) {
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.questions)) return data.questions;
    return [];
  } catch {
    return [];
  }
}

async function extractOfficeText(file) {
  const buffer = await file.arrayBuffer();
  const candidates = [];

  // 尝试从 UTF-16LE 文本段中恢复题目内容（老版 .doc 常见）。
  const utf16Text = extractUtf16LeRuns(buffer);
  if (utf16Text) candidates.push(utf16Text);

  const gbText = tryDecodeWithEncoding(buffer, "gb18030");
  if (gbText) candidates.push(gbText);

  const utf8Text = tryDecodeWithEncoding(buffer, "utf-8");
  if (utf8Text) candidates.push(utf8Text);

  return pickBestExtractedText(candidates);
}

function extractUtf16LeRuns(buffer) {
  const u16 = new Uint16Array(buffer);
  const runs = [];
  let current = "";

  for (let i = 0; i < u16.length; i += 1) {
    const code = u16[i];

    if (code === 0x000a || code === 0x000d || code === 0x0009) {
      if (current.length >= 4) runs.push(current.trim());
      current = "";
      continue;
    }

    if (isLikelyReadableChar(code)) {
      current += String.fromCharCode(code);
      continue;
    }

    if (current.length >= 4) runs.push(current.trim());
    current = "";
  }

  if (current.length >= 4) runs.push(current.trim());
  return runs.join("\n");
}

function isLikelyReadableChar(code) {
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  if (code >= 0x3400 && code <= 0x4dbf) return true;
  if (code >= 0x0020 && code <= 0x007e) return true;
  if (code >= 0xff01 && code <= 0xff5e) return true;
  if ([0x3001, 0x3002, 0x300a, 0x300b, 0x3010, 0x3011].includes(code)) return true;
  return false;
}

function tryDecodeWithEncoding(buffer, encoding) {
  try {
    const decoded = new TextDecoder(encoding, { fatal: false }).decode(buffer);
    return sanitizeExtractedText(decoded);
  } catch {
    return "";
  }
}

function sanitizeExtractedText(text) {
  const cleaned = String(text || "")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  const lines = cleaned
    .split("\n")
    .map((line) => normalizeDocNoiseLine(line))
    .map((line) => line.trim())
    .filter((line) => line.length >= 2)
    .filter((line) => /[\u4e00-\u9fffA-Za-z0-9]/.test(line))
    .filter((line) => !isLikelyNoiseLine(line));

  return [...new Set(lines)].join("\n");
}

function normalizeDocNoiseLine(input) {
  let line = String(input || "");

  // 常见 .doc 样式/分页碎片，命中后截断，避免污染题干与答案。
  const hardCutMarkers = [
    "PAGE PAGE",
    "PAGE",
    " BODY TEXT",
    " Body text",
    "_BODY TEXT",
    "_Body text",
    "普通表格",
    "默认段落字体",
  ];

  for (const marker of hardCutMarkers) {
    const idx = line.indexOf(marker);
    if (idx >= 0) {
      line = line.slice(0, idx);
    }
  }

  return line
    .replace(/\s{2,}/g, " ")
    .replace(/^[|]+|[|]+$/g, "")
    .trim();
}

function isLikelyNoiseLine(line) {
  const text = String(line || "").trim();
  if (!text) return true;
  if (/\uFFFD/.test(text)) return true;
  if (/^(PAGE|BODY\s*TEXT|_BODY\s*TEXT)\b/i.test(text)) return true;
  if (/^(标题\s*\d+|普通表格\s*\d*)$/i.test(text)) return true;
  if (isLikelyGarbledLine(text)) return true;

  const asciiChunkHits = (text.match(/[A-Z_]{4,}(?:\d+)?/g) || []).length;
  if (asciiChunkHits >= 3 && !/[\u4e00-\u9fff]/.test(text)) return true;

  return false;
}

function isLikelyGarbledLine(line) {
  const text = String(line || "").trim();
  if (!text) return false;
  if (text.length < 24) return false;

  const chars = [...text];
  const total = chars.length;
  const weirdCount = chars.filter((ch) => /[^\u4e00-\u9fffA-Za-z0-9\s，。！？；：、“”‘’（）()《》【】\[\]、,.!?;:'"\-_]/.test(ch)).length;
  const weirdRatio = weirdCount / total;

  const hanChars = chars.filter((ch) => /[\u4e00-\u9fff]/.test(ch));
  const hanCounts = new Map();
  for (const ch of hanChars) {
    hanCounts.set(ch, (hanCounts.get(ch) || 0) + 1);
  }
  let maxHan = 0;
  for (const count of hanCounts.values()) {
    if (count > maxHan) maxHan = count;
  }

  const dominantHanRatio = hanChars.length ? maxHan / hanChars.length : 0;
  const punctCount = (text.match(/[，。！？；：,.!?;:]/g) || []).length;
  const hasLongRepeat = /(.)\1{5,}/.test(text);

  if (hasLongRepeat) return true;
  if (weirdRatio > 0.15) return true;
  if (hanChars.length >= 20 && dominantHanRatio > 0.22) return true;
  if (text.length > 80 && punctCount === 0 && weirdRatio > 0.08) return true;

  return false;
}

function pickBestExtractedText(candidates) {
  if (!candidates.length) return "";

  let best = "";
  let bestScore = -1;

  for (const candidate of candidates) {
    const lines = candidate.split("\n").filter(Boolean);
    const lenScore = Math.min(candidate.length / 40, 200);
    const lineScore = Math.min(lines.length, 120);
    const keywordHits = (candidate.match(/(单选|多选|判断|填空|简答|答案|解析|[A-H][\.、．])/g) || []).length;
    const noiseHits = (candidate.match(/[\uFFFD]/g) || []).length;
    const score = lenScore + lineScore + keywordHits * 4 - noiseHits * 6;

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function parseTextBank(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const questions = [];
  let current = null;
  let sectionType = "single";
  let waitingAnswerValue = false;
  let waitingExplanationValue = false;
  let collectingAnswer = false;
  let collectingExplanation = false;

  const sectionReg = /(单选|多选|判断|填空|简答|大题)/;
  const qStartReg = /^(\d+)[\.、．]\s*(.+)$/;
  const answerReg = /^[\(（\[【]?\s*(答案|参考答案|答|答案要点|参考答案要点)\s*[\)）\]】]?\s*[:：]?\s*(.*)$/;
  const expReg = /^[\(（\[【]?\s*(解析|说明|解答)\s*[\)）\]】]?\s*[:：]?\s*(.*)$/;

  for (const line of lines) {
    if (sectionReg.test(line)) {
      if (line.includes("多选")) sectionType = "multiple";
      else if (line.includes("判断")) sectionType = "judge";
      else if (line.includes("填空")) sectionType = "blank";
      else if (line.includes("简答") || line.includes("大题")) sectionType = "essay";
      else sectionType = "single";
      waitingAnswerValue = false;
      waitingExplanationValue = false;
      collectingAnswer = false;
      collectingExplanation = false;
      continue;
    }

    const qMatch = line.match(qStartReg);
    if (qMatch && !isSubsectionHeading(line)) {
      const stemText = cleanQuestionStem(qMatch[2]);
      if (!stemText) continue;
      if (current) questions.push(current);
      current = {
        id: `q_${questions.length + 1}`,
        type: sectionType,
        stem: stemText,
        options: [],
        answer: [],
        score: sectionType === "essay" ? 10 : 2,
        explanation: "",
      };
      waitingAnswerValue = false;
      waitingExplanationValue = false;
      collectingAnswer = false;
      collectingExplanation = false;
      continue;
    }

    if (!current) continue;

    if (collectingAnswer && !line.match(expReg) && !line.match(answerReg)) {
      if (isLikelyNoiseLine(line) || isLikelyGarbledLine(line)) {
        collectingAnswer = false;
        continue;
      }
      appendAnswerLine(current, line);
      continue;
    }

    if (collectingExplanation && !line.match(answerReg) && !line.match(expReg)) {
      if (isLikelyNoiseLine(line) || isLikelyGarbledLine(line)) {
        collectingExplanation = false;
        continue;
      }
      current.explanation = current.explanation ? `${current.explanation} ${line}` : line;
      continue;
    }

    if (line.match(expReg)) collectingAnswer = false;
    if (line.match(answerReg)) collectingExplanation = false;

    if (waitingAnswerValue) {
      const maybeExp = line.match(expReg);
      if (!maybeExp && !isLikelyNoiseLine(line) && !isLikelyGarbledLine(line)) {
        current.answer = normalizeAnswer(line, current.type);
        collectingAnswer = current.type === "essay";
      }
      waitingAnswerValue = false;
      if (!maybeExp) continue;
    }

    if (waitingExplanationValue) {
      const maybeAnswer = line.match(answerReg);
      if (!maybeAnswer && !isLikelyNoiseLine(line)) {
        current.explanation = line;
        collectingExplanation = true;
      }
      waitingExplanationValue = false;
      if (!maybeAnswer) continue;
    }

    const inlineOptions = splitInlineOptions(line);
    if (inlineOptions.length) {
      for (const optionText of inlineOptions) {
        if (!current.options.includes(optionText)) current.options.push(optionText);
      }
      continue;
    }

    const aMatch = line.match(answerReg);
    if (aMatch) {
      const answerText = String(aMatch[2] || "").trim();
      if (answerText) {
        current.answer = normalizeAnswer(answerText, current.type);
        collectingAnswer = current.type === "essay";
      } else {
        waitingAnswerValue = true;
        collectingAnswer = false;
      }
      continue;
    }

    const eMatch = line.match(expReg);
    if (eMatch) {
      const explanationText = String(eMatch[2] || "").trim();
      if (explanationText) {
        current.explanation = explanationText;
        collectingExplanation = true;
      } else {
        waitingExplanationValue = true;
        collectingExplanation = false;
      }
      continue;
    }

    // 连续文本归入题干，兼容跨行题目描述；疑似乱码行不拼接。
    if (!isLikelyNoiseLine(line) && !isLikelyGarbledLine(line)) {
      current.stem += ` ${cleanQuestionStem(line)}`;
    }
  }

  if (current) questions.push(current);
  return questions;
}

function appendAnswerLine(question, line) {
  const text = String(line || "").trim();
  if (!text) return;

  if (question.type === "essay" || question.type === "blank") {
    const prev = String((question.answer && question.answer[0]) || "").trim();
    question.answer = [prev ? `${prev} ${text}` : text];
    return;
  }

  const prev = Array.isArray(question.answer) ? question.answer.join("") : String(question.answer || "");
  question.answer = normalizeAnswer(`${prev}${text}`, question.type);
}

function cleanQuestionStem(text) {
  const normalized = normalizeDocNoiseLine(text);
  const cutByMarker = normalized
    .replace(/\bPAGE\b.*$/i, "")
    .replace(/\b_BODY\s*TEXT\b.*$/i, "")
    .replace(/\bBODY\s*TEXT\b.*$/i, "")
    .trim();

  const cutByQuestionTail = stripNoisyTailAfterQuestionMark(cutByMarker);
  const cutBySuspiciousBlock = stripSuspiciousBlockTail(cutByQuestionTail);

  return cutBySuspiciousBlock.replace(/\s{2,}/g, " ").trim();
}

function stripNoisyTailAfterQuestionMark(text) {
  const source = String(text || "").trim();
  if (!source) return "";

  const idx = source.search(/[？?]/);
  if (idx < 0) return source;
  if (idx === source.length - 1) return source;

  const tail = source.slice(idx + 1).trim();
  if (!tail) return source.slice(0, idx + 1);

  const looksNoisy =
    isLikelyNoiseLine(tail) ||
    isLikelyGarbledLine(tail) ||
    /[%$#@]{2,}|\b(?:PAGE|BODY\s*TEXT|_BODY\s*TEXT)\b/i.test(tail) ||
    // 问号后出现异常长且无自然断句的尾巴，通常是 doc 解码残留。
    (tail.length > 30 && !/[。！？?!]/.test(tail));

  return looksNoisy ? source.slice(0, idx + 1) : source;
}

function stripSuspiciousBlockTail(text) {
  const source = String(text || "").trim();
  if (!source) return "";

  const suspicious = findSuspiciousTailStart(source);
  if (suspicious < 0) return source;

  // 如果前面已有问号，优先保留到问号；否则保留到可疑段前。
  const qIdx = source.search(/[？?]/);
  if (qIdx >= 0 && qIdx < suspicious) {
    return source.slice(0, qIdx + 1).trim();
  }

  return source.slice(0, suspicious).trim();
}

function findSuspiciousTailStart(text) {
  const source = String(text || "");
  if (source.length < 10) return -1;

  // CJK 扩展 A（3400-4DBF）在常规中文题干极少出现，连续出现通常是 doc 垃圾流。
  const extAReg = /[\u3400-\u4DBF]{2,}/g;
  let m = extAReg.exec(source);
  if (m && m.index >= 4) return m.index;

  // 私有区字符通常来自格式残留。
  const puaReg = /[\uE000-\uF8FF]/g;
  m = puaReg.exec(source);
  if (m && m.index >= 4) return m.index;

  // 字体/样式残片模式。
  const fontNoise = /\b(?:Times\s+Roman|Calibri|Arial|Body\s*text|普通\(网站\)|默认段落字体)\b/i;
  const markerMatch = source.match(fontNoise);
  if (markerMatch && markerMatch.index >= 4) return markerMatch.index;

  // 高密度异常块：如“䮁H尀脈䈦”这类混合串。
  const weirdBlockReg = /[^\u4e00-\u9fffA-Za-z0-9\s，。！？；：、“”‘’（）()《》【】\[\]、,.!?;:'"\-_]{6,}/g;
  m = weirdBlockReg.exec(source);
  if (m && m.index >= 4) return m.index;

  return -1;
}

function isSubsectionHeading(line) {
  const text = String(line || "").trim();
  if (/^第[一二三四五六七八九十百千\d]+章/.test(text)) return true;
  if (/^第[一二三四五六七八九十百千\d]+节/.test(text)) return true;
  // 形如 11.2、11.2.1 的小节编号，避免误判成题号。
  if (/^\d+\.\d+(\.\d+)*($|\s)/.test(text)) return true;
  return false;
}

function splitInlineOptions(line) {
  const source = String(line || "").replace(/\s+/g, " ").trim();
  if (!source) return [];

  const matches = [...source.matchAll(/([A-H])[\.、．]\s*(.*?)(?=(?:\s*[A-H][\.、．]\s*)|$)/gi)];
  if (!matches.length) return [];

  return matches
    .map((m) => `${m[1].toUpperCase()}. ${m[2].trim()}`)
    .filter((item) => item.length > 3);
}

function normalizeQuestions(questions) {
  return questions
    .map((q, idx) => {
      const type = normalizeType(q.type);
      return {
        id: q.id || `q_${idx + 1}`,
        type,
        stem: String(q.stem || "").trim(),
        options: Array.isArray(q.options) ? q.options : [],
        answer: normalizeAnswer(q.answer, type),
        score: Number(q.score) > 0 ? Number(q.score) : type === "essay" ? 10 : 2,
        explanation: String(q.explanation || "").trim(),
      };
    })
    .filter((q) => q.stem);
}

function normalizeType(input) {
  const value = String(input || "").toLowerCase();
  if (/single|单选/.test(value)) return "single";
  if (/multiple|多选/.test(value)) return "multiple";
  if (/judge|判断/.test(value)) return "judge";
  if (/blank|填空/.test(value)) return "blank";
  if (/essay|简答|大题/.test(value)) return "essay";
  return "single";
}

function normalizeAnswer(raw, type) {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim().toUpperCase()).filter(Boolean);
  }

  const text = String(raw || "").trim();
  if (!text) return [];

  if (type === "judge") {
    const upper = text.toUpperCase();
    if (["T", "TRUE", "对", "正确", "Y", "YES"].includes(upper)) return ["T"];
    if (["F", "FALSE", "错", "错误", "N", "NO"].includes(upper)) return ["F"];
    return [upper.startsWith("对") ? "T" : "F"];
  }

  if (type === "blank" || type === "essay") {
    return [text];
  }

  const letters = text
    .toUpperCase()
    .replace(/[^A-H]/g, "")
    .split("")
    .filter(Boolean);

  return [...new Set(letters)].sort();
}

function initQuiz(questions) {
  state.questions = questions;
  state.answers = {};
  state.index = 0;
  state.startAt = Date.now();
  els.parseHint.textContent = `已解析 ${questions.length} 题，开始答题`;
  els.quizPanel.classList.remove("hidden");
  els.resultPanel.classList.add("hidden");
  renderQuestion();
  startTimer();
}

function renderQuestion() {
  const q = state.questions[state.index];
  if (!q) return;

  els.progressText.textContent = `${state.index + 1} / ${state.questions.length}`;

  let body = `
    <span class="question-type">${TYPE_MAP[q.type] || q.type}</span>
    <h3 class="question-title">${escapeHtml(q.stem)}</h3>
  `;

  if (q.type === "single" || q.type === "multiple") {
    const inputType = q.type === "single" ? "radio" : "checkbox";
    const selected = state.answers[q.id] || [];
    body += `<div class="options">${q.options
      .map((op, i) => {
        const letter = String.fromCharCode(65 + i);
        const checked = selected.includes(letter) ? "checked" : "";
        return `<label class="option"><input type="${inputType}" name="option" value="${letter}" ${checked}/> ${escapeHtml(op)}</label>`;
      })
      .join("")}</div>`;
  } else if (q.type === "judge") {
    const selected = (state.answers[q.id] || [])[0] || "";
    body += `
      <div class="options">
        <label class="option"><input type="radio" name="judge" value="T" ${selected === "T" ? "checked" : ""}/> 对</label>
        <label class="option"><input type="radio" name="judge" value="F" ${selected === "F" ? "checked" : ""}/> 错</label>
      </div>
    `;
  } else if (q.type === "blank") {
    const value = (state.answers[q.id] || [""])[0];
    body += `<input class="blank-input" type="text" value="${escapeHtml(value)}" placeholder="请输入答案"/>`;
  } else {
    const value = (state.answers[q.id] || [""])[0];
    body += `<textarea class="essay-input" placeholder="请输入作答内容">${escapeHtml(value)}</textarea>`;
  }

  els.questionBox.innerHTML = body;
  bindInputEvents(q);
}

function bindInputEvents(question) {
  if (question.type === "single" || question.type === "multiple") {
    const inputs = els.questionBox.querySelectorAll("input[name='option']");
    inputs.forEach((el) => {
      el.addEventListener("change", () => {
        const values = Array.from(inputs)
          .filter((i) => i.checked)
          .map((i) => i.value)
          .sort();
        state.answers[question.id] = values;
      });
    });
    return;
  }

  if (question.type === "judge") {
    const inputs = els.questionBox.querySelectorAll("input[name='judge']");
    inputs.forEach((el) => {
      el.addEventListener("change", () => {
        const checked = Array.from(inputs).find((i) => i.checked);
        state.answers[question.id] = checked ? [checked.value] : [];
      });
    });
    return;
  }

  const input = els.questionBox.querySelector(question.type === "blank" ? ".blank-input" : ".essay-input");
  if (input) {
    input.addEventListener("input", () => {
      state.answers[question.id] = [input.value.trim()];
    });
  }
}

function switchQuestion(delta) {
  const next = state.index + delta;
  if (next < 0 || next >= state.questions.length) return;
  state.index = next;
  renderQuestion();
}

function submitQuiz() {
  stopTimer();
  const details = [];
  let objectiveTotal = 0;
  let objectiveScore = 0;

  for (const q of state.questions) {
    const userAnswer = state.answers[q.id] || [];
    const correct = isCorrect(q, userAnswer);
    const canAutoScore = q.type !== "essay";

    if (canAutoScore) {
      objectiveTotal += q.score;
      if (correct) objectiveScore += q.score;
    }

    details.push({
      id: q.id,
      type: q.type,
      stem: q.stem,
      userAnswer,
      rightAnswer: q.answer,
      explanation: q.explanation,
      score: q.score,
      autoScored: canAutoScore,
      correct,
    });
  }

  renderResult(objectiveScore, objectiveTotal, details);
}

function isCorrect(question, userAnswer) {
  if (question.type === "essay") return false;

  if (question.type === "blank") {
    const user = String(userAnswer[0] || "").trim().toLowerCase();
    const right = String(question.answer[0] || "").trim().toLowerCase();
    return Boolean(user && right && user === right);
  }

  const user = [...userAnswer].map((a) => a.toUpperCase()).sort().join("");
  const right = [...question.answer].map((a) => a.toUpperCase()).sort().join("");
  return user && user === right;
}

function renderResult(score, total, details) {
  els.quizPanel.classList.add("hidden");
  els.resultPanel.classList.remove("hidden");
  els.scoreText.textContent = `客观题得分：${score} / ${total}`;

  els.resultList.innerHTML = details
    .map((d, idx) => {
      const statusClass = d.autoScored ? (d.correct ? "ok" : "bad") : "";
      const statusText = d.autoScored ? (d.correct ? "正确" : "错误") : "主观题（未自动判分）";
      return `
        <div class="result-item ${statusClass}">
          <p><strong>${idx + 1}. ${escapeHtml(d.stem)}</strong></p>
          <p class="result-meta">题型：${TYPE_MAP[d.type] || d.type} | 分值：${d.score} | 结果：${statusText}</p>
          <p>你的答案：${escapeHtml(formatAnswer(d.userAnswer, d.type))}</p>
          <p>参考答案：${escapeHtml(formatAnswer(d.rightAnswer, d.type)) || "-"}</p>
          <p>解析：${escapeHtml(d.explanation || "暂无")}</p>
        </div>
      `;
    })
    .join("");
}

function retryQuiz() {
  state.index = 0;
  state.answers = {};
  state.startAt = Date.now();
  els.resultPanel.classList.add("hidden");
  els.quizPanel.classList.remove("hidden");
  renderQuestion();
  startTimer();
}

function formatAnswer(answer, type) {
  if (!answer || !answer.length) return "未作答";
  if (type === "judge") return answer[0] === "T" ? "对" : "错";
  if (type === "blank" || type === "essay") return answer[0];
  return answer.join(", ");
}

function startTimer() {
  stopTimer();
  state.timerId = setInterval(() => {
    const seconds = Math.floor((Date.now() - state.startAt) / 1000);
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");
    els.timerText.textContent = `${mm}:${ss}`;
  }, 1000);
}

function stopTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
}

function escapeHtml(input) {
  return String(input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
