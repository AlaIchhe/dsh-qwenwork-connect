/**
 * Unified error taxonomy, secret redaction, and upstream failure classification.
 */

export const QwenErrorCode = {
  CREDENTIALS_MISSING: 'CREDENTIALS_MISSING',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  TOKEN_EXPIRED_NO_REFRESH: 'TOKEN_EXPIRED_NO_REFRESH',
  REFRESH_REJECTED: 'REFRESH_REJECTED',
  REFRESH_NETWORK: 'REFRESH_NETWORK',
  API_UNAUTHORIZED: 'API_UNAUTHORIZED',
  API_ERROR: 'API_ERROR',
  TLS_CERTIFICATE: 'TLS_CERTIFICATE',
} as const;

export type QwenErrorCodeValue = (typeof QwenErrorCode)[keyof typeof QwenErrorCode];

const RECOVERY_HINTS: Readonly<Record<QwenErrorCodeValue, string>> = Object.freeze({
  [QwenErrorCode.CREDENTIALS_MISSING]:
    '尚未登录千问办公。请在插件设置卡片点击「登录」，或运行 `npx dsh-qwenwork-connect login`。',
  [QwenErrorCode.SCHEMA_INVALID]:
    '本地凭据格式无效或已损坏，请重新登录。',
  [QwenErrorCode.TOKEN_EXPIRED_NO_REFRESH]:
    '登录已过期且缺少 refresh token，请重新登录。',
  [QwenErrorCode.REFRESH_REJECTED]:
    '续期被网关拒绝（refresh token 可能已撤销或过期），请重新登录。',
  [QwenErrorCode.REFRESH_NETWORK]:
    '续期时网络请求失败，请检查网络后重试。',
  [QwenErrorCode.API_UNAUTHORIZED]:
    '接口鉴权失败，登录态可能已失效，请重新登录。',
  [QwenErrorCode.API_ERROR]:
    '上游网关请求失败，请稍后重试。',
  [QwenErrorCode.TLS_CERTIFICATE]:
    '企业 VPC 网关证书校验失败。请在插件配置中设置 `vpc.caCertPath`（自签根证书路径）或显式开启 `vpc.insecureTls: true`。',
});

export class QwenError extends Error {
  readonly code: QwenErrorCodeValue;
  readonly recovery: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: QwenErrorCodeValue,
    message: string,
    opts: { cause?: unknown; recovery?: string; retryable?: boolean; status?: number } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'QwenError';
    this.code = code;
    this.recovery = opts.recovery ?? RECOVERY_HINTS[code];
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
  }

  toJSON() {
    return {
      code: this.code,
      message: redactSecrets(this.message),
      ...(this.recovery !== '' ? { recovery: redactSecrets(this.recovery) } : {}),
      retryable: this.retryable,
    };
  }
}

export function isQwenError(error: unknown): error is QwenError {
  return error instanceof QwenError;
}

const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu;
const SECRET_KV_RE = /(\b(?:code|token|refresh_token|access_token|id_token|secret|password)=)[^&\s]+/giu;

export function redactSecrets(input: unknown, maxLength = 500): string {
  const raw = input instanceof Error ? input.message : String(input ?? '');
  return raw
    .replace(JWT_RE, '[redacted token]')
    .replace(BEARER_RE, '$1[redacted]')
    .replace(SECRET_KV_RE, '$1[redacted]')
    .slice(0, maxLength);
}

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function isTlsCertError(error: unknown): boolean {
  let cur: unknown = error;
  for (let depth = 0; depth < 5 && cur !== null && typeof cur === 'object'; depth += 1) {
    const rec = cur as { code?: unknown; cause?: unknown };
    if (typeof rec.code === 'string' && TLS_ERROR_CODES.has(rec.code)) return true;
    cur = rec.cause;
  }
  return false;
}

// ── Upstream failure classification ─────────────────────────────────────────

const QUEUED_CODE = '10605';
const QUOTA_CODES = new Set(['110', '112', '113', '114', '115', '116', '117', '118', '119', '122']);
const REQUEST_CODES = new Set(['406', '416', '430', '80411', '80412', '100400', '100401', '100403']);
const ALL_MODELS_FAILED_RE = /all models failed/i;
const UPSTREAM_FAILED_RE = /error in upstream response/i;
const QUOTA_TEXT_RE =
  /quota|credits?|usage limit|insufficient (?:balance|quota|credits?)|out of credits?|exceeded.*(?:quota|limit)|余额不足|额度/i;
const DEFAULT_BUSY_WAIT_SEC = 30;

export interface ParsedUpstreamFailure {
  readonly status?: number;
  readonly code?: string;
  readonly message?: string;
  readonly queue?: Record<string, unknown>;
}

export type ClassifiedFailureKind =
  | 'QUEUED'
  | 'QUOTA_EXCEEDED'
  | 'INVALID_REQUEST'
  | 'MODEL_POOL_BUSY'
  | 'AUTH'
  | 'SERVER';

export interface ClassifiedUpstreamFailure {
  readonly status: number;
  readonly kind: ClassifiedFailureKind;
  readonly llmCode: 'AUTH' | 'QUOTA' | 'RATE_LIMIT' | 'INVALID_REQUEST' | 'SERVER';
  readonly message: string;
  readonly retryAfterMs?: number;
}

export function parseUpstreamFailureText(input: unknown): ParsedUpstreamFailure {
  if (isRecord(input)) return fromParsedRecord(input);
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') return {};
  const parsed = tryParseJson(raw);
  if (!isRecord(parsed)) return { message: raw.slice(0, 400) };
  return fromParsedRecord(parsed);
}

function fromParsedRecord(json: Record<string, unknown>): ParsedUpstreamFailure {
  const status = toPositiveInt(json.statusCodeValue ?? json.statusCode);
  let code = json.code === undefined || json.code === null ? '' : String(json.code);
  let message = typeof json.message === 'string' ? json.message : '';
  let queue = isRecord(json.queue) ? json.queue : undefined;

  if (json.details !== undefined) {
    const details = typeof json.details === 'string' ? tryParseJson(json.details) : json.details;
    const detailMessage =
      isRecord(details) && isRecord(details.error) && typeof details.error.message === 'string'
        ? details.error.message
        : undefined;
    if (detailMessage !== undefined && detailMessage !== '') {
      message = message === '' ? detailMessage : `${message}: ${detailMessage}`;
    }
  }

  const nested = tryParseJson(message);
  if (isRecord(nested)) {
    if (['', '401', '403'].includes(code) && nested.code !== undefined && nested.code !== null) {
      code = String(nested.code);
    }
    if (typeof nested.message === 'string' && nested.message !== '') {
      message = nested.message;
    }
    if (queue === undefined && isRecord(nested.queue)) queue = nested.queue;
    if (queue === undefined && hasQueueFields(nested)) queue = nested;
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(code === '' ? {} : { code }),
    ...(message === '' ? {} : { message }),
    ...(queue === undefined ? {} : { queue }),
  };
}

export function classifyUpstreamFailure(input: ParsedUpstreamFailure = {}): ClassifiedUpstreamFailure {
  const status = toPositiveInt(input.status);
  const code = input.code ?? '';
  const message =
    typeof input.message === 'string' && input.message.trim() !== ''
      ? redactSecrets(input.message.trim(), 400)
      : status === undefined
        ? 'upstream error'
        : `HTTP ${status}`;
  const queue = isRecord(input.queue) ? input.queue : undefined;

  if (code === QUEUED_CODE || queue?.isQueued === true || queue?.serviceAvailable === false) {
    const waitSec = retryAfterSecondsOf(queue);
    const label = queue?.isQueued === true ? '已排队' : '正忙';
    return {
      status: 503,
      kind: 'QUEUED',
      llmCode: 'SERVER',
      message: `千问办公${label}（queued），约 ${waitSec} 秒后重试：${message}`,
      retryAfterMs: waitSec * 1000,
    };
  }

  if (QUOTA_CODES.has(code)) {
    return {
      status: 429,
      kind: 'QUOTA_EXCEEDED',
      llmCode: 'QUOTA',
      message: `用量已用完（insufficient quota）：${message}`,
    };
  }

  if (REQUEST_CODES.has(code)) {
    return {
      status: 400,
      kind: 'INVALID_REQUEST',
      llmCode: 'INVALID_REQUEST',
      message: `千问办公拒绝了这次请求（${code}）：${message}`,
    };
  }

  if (status === 402 || code === '402') {
    return {
      status: 402,
      kind: 'QUOTA_EXCEEDED',
      llmCode: 'QUOTA',
      message: `当前账号额度或套餐不支持此次请求（HTTP 402）：${message}`,
    };
  }

  if (status === 400 || code === '400') {
    return {
      status: 400,
      kind: 'INVALID_REQUEST',
      llmCode: 'INVALID_REQUEST',
      message: `千问办公拒绝了这次请求（HTTP 400，参数可能超出模型限制）：${message}`,
    };
  }

  if (UPSTREAM_FAILED_RE.test(message)) {
    return {
      status: 502,
      kind: 'SERVER',
      llmCode: 'SERVER',
      message: `上游服务错误（HTTP 502）：${message}`,
    };
  }

  if (ALL_MODELS_FAILED_RE.test(message)) {
    return {
      status: 503,
      kind: 'MODEL_POOL_BUSY',
      llmCode: 'SERVER',
      message: `千问办公模型池暂时不可用（model pool busy），约 ${DEFAULT_BUSY_WAIT_SEC} 秒后重试：${message}`,
      retryAfterMs: DEFAULT_BUSY_WAIT_SEC * 1000,
    };
  }

  if (status === 401 || status === 403) {
    return {
      status: 401,
      kind: 'AUTH',
      llmCode: 'AUTH',
      message: `登录已失效，请重新登录（上游 ${status}：${message}）`,
    };
  }

  if (QUOTA_TEXT_RE.test(message)) {
    return {
      status: 429,
      kind: 'QUOTA_EXCEEDED',
      llmCode: 'QUOTA',
      message: `用量已用完（insufficient quota）：${message}`,
    };
  }

  if (status === 429) {
    return {
      status: 429,
      kind: 'MODEL_POOL_BUSY',
      llmCode: 'RATE_LIMIT',
      message: `上游限流（rate limit），约 ${DEFAULT_BUSY_WAIT_SEC} 秒后重试：${message}`,
      retryAfterMs: DEFAULT_BUSY_WAIT_SEC * 1000,
    };
  }

  if (status !== undefined && status >= 500) {
    return { status, kind: 'SERVER', llmCode: 'SERVER', message };
  }

  if (status === 400) {
    return { status: 400, kind: 'INVALID_REQUEST', llmCode: 'INVALID_REQUEST', message };
  }

  return {
    status: status ?? 502,
    kind: status !== undefined && status >= 500 ? 'SERVER' : 'INVALID_REQUEST',
    llmCode: status !== undefined && status >= 500 ? 'SERVER' : 'INVALID_REQUEST',
    message,
  };
}

function retryAfterSecondsOf(queue: Record<string, unknown> | undefined): number {
  const n = Number(queue?.retryAfterSeconds);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : DEFAULT_BUSY_WAIT_SEC;
}

function hasQueueFields(value: Record<string, unknown>): boolean {
  return 'isQueued' in value || 'serviceAvailable' in value || 'retryAfterSeconds' in value;
}

function toPositiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function tryParseJson(value: string): unknown {
  if (value.trim() === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
