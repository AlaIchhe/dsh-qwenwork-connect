/**
 * Heuristic detector for "announced a next action but emitted no tool calls".
 * Zero IO, pure function.
 */

const TAIL_BLOCK_COUNT = 2;
const TAIL_CHAR_LIMIT = 600;
const MIN_WEIGHTED_CHARS = 14;

const REQUEST_PATTERNS: readonly RegExp[] = [
  /请你?(?:确认|批准|授权|选择|决定|提供|粘贴|发送|告知|告诉|现在|立刻|马上|配合|扫码|扫|在)/,
  /你(?:可以|需要|来)(?:确认|决定|选择|提供|先)/,
  /需要你(?:确认|决定|操作|提供|回复|选择)/,
  /(?:是否|要不要|需不需要|要不要我|需要我)(?:继续|执行|我|帮|先|再)?/,
  /等你(?:确认|回复|决定|操作|安排|一句话|发话|开口|拍板|点头|指示)/,
  /(?:你|您)(?:的)?一句话[^。！？\n]{0,16}(?:我|就)/,
  /告诉我(?:你|是否|要|结果|选择|一声|什么时候)/,
  /(?:说|吱|喊)一声/,
  /你(?:点个?头|说[「“"']?开[」”"']?)(?:我就|我立刻|我马上)?/,
  /要我[^。！？\n]{0,24}(?:就|的话|吗)/,
  /扫完(?:不用回复|告诉我|说一声)/,
  /让我知道/,
  /由你(?:决定|来|选|定)/,
  /你(?:先|来)(?:确认|决定|操作|选|说)/,
  /确认后(?:我)?再/,
  /(?:你|您)看(?:看|一下)?(?:是否|要不要|行不行)/,
  /\blet me know\b/i,
  /\bwould you like\b/i,
  /\bdo you want\b/i,
  /\bshall i\b/i,
  /\bplease (?:confirm|advise|provide|choose)\b/i,
  /\byour call\b/i,
  /\bwhich (?:one|option|approach) (?:do you|would you)\b/i,
  /\bcan you (?:confirm|provide|share|tell)\b/i,
  /\bwaiting (?:for|on) your\b/i,
];

const STANDING_RULE_PATTERNS: readonly RegExp[] = [
  /(?:以后|今后|之后|下次|后续|往后|接下来每次|每当|每次)[^。！？\n]{0,40}(?:提到|遇到|收到|让我|你让我|要求|需要|开始|做|时|的时候)[^。！？\n]{0,30}我(?:会|将|都会|先|就)/,
  /^(?:可以|好的?|明白|没问题|收到|记下了|知道了)[，,。！!\s]*(?:主人|小主|老板)?[，,。！!\s]*(?:以后|今后|之后|下次|后续|往后|每当|每次)/,
];

const DONE_PATTERNS: readonly RegExp[] = [
  /(?:已|已经)(?:经)?(?:完成|修好|改好|搞定|处理完|就绪|生效|上线|发布|通过)/,
  /(?:全部|都)(?:完成|通过|搞定|就绪|闭合)/,
  /(?:搞定|收工|完事|可以收尾)(?:了)?[。.!！]?$/,
  /(?:到|就)这里(?:为止|结束)?/,
  /(?:没有|无需)(?:其他|更多|别的)(?:改动|问题|需要)/,
  /\b(?:all )?done\b/i,
  /\b(?:finished|completed|ready to go)\b/i,
  /\bnothing (?:else|more) (?:to do|needed)\b/i,
  /\ball (?:tests? )?pass(?:ed|ing)?\b/i,
];

const FUTURE_STRONG: readonly RegExp[] = [
  /我(?:先|这就|马上|立刻|接下来|现在)/,
  /我(?:来|将|会|要|去)(?:先|先来)?/,
  /先让我/,
  /让(?:我们|我)先/,
  /(?:接下来|下面|现在)我(?:来|将|会|要)/,
  /开始(?:执行|处理|修改|实现|写|改|跑|检查)/,
  /(?:^|[。！？\n]\s*)(?:开始[。，,\s]*)?先(?:把|将|从|去|给|对|用|跑|看|查|改|写|读|登记|核对|整理|创建|执行|检查)[^。！？\n]{1,60}再/,
  /(?:^|[。！？\n]\s*)现在(?:重新|开始|把|将|先|去|来|给|对|跑|开|改|写|整理|执行|检查)/,
  /\blet me\b/i,
  /\bi'?ll\b/i,
  /\bi will\b/i,
  /\bi'?m going to\b/i,
  /\bnow i'?ll\b/i,
  /\blet'?s\b/i,
];

const FUTURE_WEAK: readonly RegExp[] = [
  /接下来/,
  /下一步/,
  /下面(?:我|我们)?/,
  /然后(?:我|我们)?/,
  /首先/,
  /现在(?:我|我们)?/,
  /\bnext,?\b/i,
];

const ACTION_VERB: readonly RegExp[] = [
  /(?:检查|查看|看看|查一下|读取|打开|搜索|定位|核对|登记|整理)/,
  /(?:修改|改成|改掉|编辑|写入|创建|新建|删除|移除|重写|写进)/,
  /(?:执行|运行|跑一下|跑起|启动|重启|安装|部署|发布|提交|开窗口|重新开)/,
  /(?:修复|实现|添加|增加|补充|更新|替换|迁移|重构)/,
  /(?:验证|测试|校验|确认一下|跑通|编译|上机)/,
  /\b(?:check|read|open|inspect|look at|search|grep)\b/i,
  /\b(?:edit|write|create|add|remove|delete|rewrite|patch|update)\b/i,
  /\b(?:run|execute|install|deploy|build|start|restart|publish)\b/i,
  /\b(?:fix|implement|refactor|migrate|verify|test)\b/i,
];

const COLON_TAIL = /[:：]\s*$/;
const ELLIPSIS_TAIL = /(?:\.{3,}|…)\s*$/;
const THRESHOLD_STRONG = 3;
const THRESHOLD_WEAK_ONLY = 4.5;

export type StallVerdict =
  | 'stall'
  | 'had-tools'
  | 'too-short'
  | 'empty'
  | 'question'
  | 'asked-user'
  | 'standing-rule'
  | 'already-done'
  | 'no-future-cue'
  | 'weak-only';

export interface StallDetectionResult {
  readonly stall: boolean;
  readonly verdict: StallVerdict;
  readonly score: number;
  readonly signals: readonly string[];
  readonly prompt: string | null;
}

export const CONTINUE_PROMPT = [
  '你上一条回复宣布了下一步操作（例如「我先…」「接下来…」「Let me…」），但没有调用任何工具就结束了这一轮。',
  '请直接执行这个操作。',
  '如果它其实已经完成，或不需要执行，用一句话说明结论即可，不要重述计划。',
  '如果需要用户先决定，提出一个具体的问题，不要继续描述待办。',
].join('\n');

export function detectStall(
  rawText: unknown,
  options: { readonly toolCallCount?: number } = {},
): StallDetectionResult {
  const toolCallCount =
    typeof options.toolCallCount === 'number' && Number.isFinite(options.toolCallCount)
      ? options.toolCallCount
      : 0;
  const none = (verdict: StallVerdict, score = 0, signals: string[] = []): StallDetectionResult => ({
    stall: false,
    verdict,
    score,
    signals,
    prompt: null,
  });

  if (toolCallCount > 0) return none('had-tools');

  const raw = String(rawText ?? '').trim();
  if (raw === '') return none('empty');

  const text = stripNoise(raw);
  if (weightedLength(text) < MIN_WEIGHTED_CHARS) return none('too-short');

  const tail = tailOf(text);
  const trimmedRaw = raw.trim();

  if (/[?？]\s*$/.test(trimmedRaw)) return none('question');
  if (anyMatch(REQUEST_PATTERNS, tail)) return none('asked-user');
  if (anyMatch(STANDING_RULE_PATTERNS, tail)) return none('standing-rule');

  const hasStrongFuture = anyMatch(FUTURE_STRONG, tail);
  const hasWeakFuture = anyMatch(FUTURE_WEAK, tail);

  if (!hasStrongFuture && !hasWeakFuture && anyMatch(DONE_PATTERNS, tail)) {
    return none('already-done');
  }

  let score = 0;
  const signals: string[] = [];

  if (hasStrongFuture) {
    score += 2;
    signals.push('future-strong');
  }
  if (hasWeakFuture) {
    score += 1.5;
    signals.push('future-weak');
  }
  const hasVerb = anyMatch(ACTION_VERB, tail);
  if (hasVerb) {
    score += 1;
    signals.push('action-verb');
  }
  const hasColon = COLON_TAIL.test(trimmedRaw);
  if (hasColon) {
    score += 1.5;
    signals.push('colon-tail');
  }
  if (ELLIPSIS_TAIL.test(trimmedRaw)) {
    score += 0.5;
    signals.push('ellipsis-tail');
  }

  const lastLine =
    trimmedRaw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? '';
  const isActionColon =
    hasColon && hasVerb && !/^[-*•\d|]/.test(lastLine) && lastLine.length <= 160;
  if (!hasStrongFuture && !hasWeakFuture && isActionColon) {
    score += 1;
    signals.push('action-colon');
  }

  if (!hasStrongFuture && !hasWeakFuture && !isActionColon) {
    return none('no-future-cue', score, signals);
  }

  const threshold = hasStrongFuture || isActionColon ? THRESHOLD_STRONG : THRESHOLD_WEAK_ONLY;
  if (score < threshold) {
    return none('weak-only', score, signals);
  }

  return { stall: true, verdict: 'stall', score, signals, prompt: CONTINUE_PROMPT };
}

export function looksLikeAbandonedStep(
  rawText: unknown,
  options: { readonly toolCallCount?: number } = {},
): boolean {
  return detectStall(rawText, options).stall;
}

function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<\/?[a-zA-Z][^>]{0,200}>/g, ' ')
    .replace(/\[[^\]]{0,80}\]\([^)]{0,300}\)/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function tailOf(text: string): string {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) return '';
  const joined = blocks.slice(-TAIL_BLOCK_COUNT).join('\n').trim();
  return joined.length > TAIL_CHAR_LIMIT ? joined.slice(-TAIL_CHAR_LIMIT) : joined;
}

function anyMatch(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

function weightedLength(text: string): number {
  let total = 0;
  for (const ch of text) {
    total += /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch) ? 1.6 : 1;
  }
  return total;
}
