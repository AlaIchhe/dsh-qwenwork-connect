import { useEffect, useState } from 'react';
import {
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_START_PATH,
  LOGIN_STATUS_PATH,
  LOGIN_WAIT_TIMEOUT_MS,
  LOGOUT_PATH,
  MODELS_TOGGLE_PATH,
  pathForSite,
  type CardModelItem,
  type LoginPhase,
  type LoginStatusResponse,
  type SiteStatusResponse,
} from '../../shared/contracts.js';
import { SITE_CN, type SiteId } from '../../shared/sites.js';
import { siteLabel, type TranslateFn } from '../i18n.js';
import { fetchSiteStatus, patchSiteStatus, useSiteStatus } from '../store.js';
import {
  accountRowStyle,
  actionButtonStyle,
  bodyStyle,
  cardStyle,
  chevronStyle,
  descriptionStyle,
  errorStyle,
  headTextStyle,
  headerStyle,
  loginLinkStyle,
  logoutButtonStyle,
  nameStyle,
  noticePanelStyle,
  primaryButtonStyle,
  sectionStyle,
  sectionTitleStyle,
  statusDotStyle,
  toolbarStyle,
} from '../styles.js';
import { ModelsSection } from './ModelsSection.js';
import { PerfSection } from './PerfSection.js';
import { QuotaBar } from './QuotaBar.js';
import { SiteTabs } from './SiteTabs.js';

interface LocalLoginState {
  readonly phase: LoginPhase;
  readonly url?: string;
  readonly error?: string;
}

export function PluginCard(props: {
  readonly t: TranslateFn;
  readonly initialOpen?: boolean;
  readonly initialSite?: SiteId;
  readonly initialState?: SiteStatusResponse | null;
}) {
  const { t } = props;
  const [open, setOpen] = useState(props.initialOpen === true);
  const [activeSite, setActiveSite] = useState<SiteId>(props.initialSite ?? SITE_CN);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [login, setLogin] = useState<LocalLoginState | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const state = useSiteStatus(activeSite, open, {
    initialState: props.initialState,
    errorPrefix: t('requestFailed'),
  });

  // Poll login status while waiting for browser authorization
  useEffect(() => {
    if (login === null || login.phase !== 'pending') return undefined;
    let cancelled = false;
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > LOGIN_WAIT_TIMEOUT_MS) {
        clearInterval(timer);
        if (!cancelled) setLogin({ phase: 'failed', error: t('loginTimeout') });
        return;
      }
      try {
        const res = await fetch(pathForSite(LOGIN_STATUS_PATH, activeSite), {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const body = (await res.json()) as LoginStatusResponse;
        if (cancelled) return;
        if (body.phase === 'ready') {
          clearInterval(timer);
          setLogin(null);
          void fetchSiteStatus(activeSite, { force: true, errorPrefix: t('requestFailed') });
        } else if (body.phase === 'failed') {
          clearInterval(timer);
          setLogin({ phase: 'failed', error: body.error ?? t('loginFailed') });
        }
      } catch {
        /* retry next tick */
      }
    }, LOGIN_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [login, activeSite, t]);

  const handleSwitchSite = (nextSite: SiteId) => {
    if (nextSite === activeSite) return;
    setActiveSite(nextSite);
    setLogin(null);
    setLogoutError(null);
    setToggleError(null);
  };

  const handleRefresh = async () => {
    if (refreshBusy) return;
    setRefreshBusy(true);
    try {
      await fetchSiteStatus(activeSite, { force: true, errorPrefix: t('requestFailed') });
    } finally {
      setRefreshBusy(false);
    }
  };

  const handleStartLogin = async () => {
    setLoginBusy(true);
    try {
      const res = await fetch(pathForSite(LOGIN_START_PATH, activeSite), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `${t('requestFailed')} (HTTP ${res.status})`);
      if (typeof body?.url !== 'string' || body.url === '') throw new Error(t('loginFailed'));
      setLogin({ phase: 'pending', url: body.url });
      window.open(body.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setLogin({
        phase: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    if (
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm(t('logoutConfirm', { site: siteLabel(t, activeSite) }))
    ) {
      return;
    }
    setLogoutBusy(true);
    setLogoutError(null);
    try {
      const res = await fetch(pathForSite(LOGOUT_PATH, activeSite), {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `${t('requestFailed')} (HTTP ${res.status})`);
      setLogin(null);
      await fetchSiteStatus(activeSite, { force: true, errorPrefix: t('requestFailed') });
    } catch (error) {
      setLogoutError(`${t('logoutFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLogoutBusy(false);
    }
  };

  const handleToggleModel = async (model: CardModelItem) => {
    if (toggleBusy) return;
    const nextEnabled = model.enabled === false;
    setToggleBusy(true);
    setToggleError(null);
    try {
      const res = await fetch(pathForSite(MODELS_TOGGLE_PATH, activeSite), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ model: model.id, enabled: nextEnabled }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `${t('requestFailed')} (HTTP ${res.status})`);

      patchSiteStatus(activeSite, (prev) =>
        prev === null || !Array.isArray(prev.models)
          ? prev
          : {
              ...prev,
              models: prev.models.map((m) =>
                m.id === model.id ? { ...m, enabled: nextEnabled } : m,
              ),
            },
      );
      void fetchSiteStatus(activeSite, { force: true, errorPrefix: t('requestFailed') });
    } catch (error) {
      setToggleError(`${t('toggleFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setToggleBusy(false);
    }
  };

  const signedIn = state?.status === 'signed-in';
  const subtitleText =
    signedIn && state?.tierName
      ? `${siteLabel(t, activeSite)} · ${state.tierName}`
      : t('subtitle');

  const creditsEntry = state?.entitlements?.find((e) => e.key === 'credits');
  const remaining = state?.remaining ?? creditsEntry?.remain;

  return (
    <div style={cardStyle}>
      <button type="button" style={headerStyle} onClick={() => setOpen((v) => !v)}>
        <div style={headTextStyle}>
          <span style={nameStyle}>{t('title')}</span>
          <span style={descriptionStyle}>{subtitleText}</span>
        </div>
        <span
          style={{
            ...chevronStyle,
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        >
          ›
        </span>
      </button>

      {open ? (
        <div style={bodyStyle}>
          <div style={toolbarStyle}>
            <SiteTabs active={activeSite} onChange={handleSwitchSite} t={t} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {!signedIn ? (
                <button
                  type="button"
                  disabled={loginBusy || login?.phase === 'pending'}
                  style={primaryButtonStyle}
                  onClick={handleStartLogin}
                >
                  {loginBusy || login?.phase === 'pending' ? t('loggingIn') : t('login')}
                </button>
              ) : null}
              <button
                type="button"
                disabled={refreshBusy}
                style={actionButtonStyle}
                onClick={handleRefresh}
              >
                {refreshBusy ? t('refreshing') : t('refresh')}
              </button>
            </div>
          </div>

          {!signedIn && login === null ? (
            <div
              style={{
                fontSize: 13,
                lineHeight: '20px',
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              {t('loginHint')}
            </div>
          ) : null}

          {login !== null ? (
            <div style={noticePanelStyle}>
              <span>
                {login.phase === 'failed' ? (login.error ?? t('loginFailed')) : t('loginWaiting')}
              </span>
              {login.phase === 'pending' && login.url ? (
                <a
                  href={login.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={loginLinkStyle}
                >
                  {login.url}
                </a>
              ) : null}
            </div>
          ) : null}

          {logoutError !== null ? <div style={noticePanelStyle}>{logoutError}</div> : null}
          {toggleError !== null ? <div style={noticePanelStyle}>{toggleError}</div> : null}

          {state === null ? (
            <div style={errorStyle}>{t('loading')}</div>
          ) : (
            <>
              {state.error !== undefined &&
              !(state.status === 'signed-out' && state.error.code === 'CREDENTIALS_MISSING') &&
              state.status !== 'signed-in' ? (
                <div style={errorStyle}>
                  {[state.error.message, state.error.recovery].filter(Boolean).join('\n')}
                </div>
              ) : null}

              {signedIn ? (
                <div style={sectionStyle}>
                  <h3 style={sectionTitleStyle}>{t('accountHeading')}</h3>
                  <div style={accountRowStyle}>
                    <span style={statusDotStyle('signed-in')} />
                    <span>{t('signedInAs', { name: state.nickname ?? state.account ?? '—' })}</span>
                    <button
                      type="button"
                      disabled={logoutBusy}
                      style={
                        logoutBusy
                          ? { ...logoutButtonStyle, opacity: 0.6, cursor: 'default' }
                          : logoutButtonStyle
                      }
                      onClick={handleLogout}
                    >
                      {logoutBusy ? t('loggingOut') : t('logout')}
                    </button>
                  </div>
                </div>
              ) : null}

              {signedIn && typeof remaining === 'number' ? (
                <QuotaBar
                  remaining={remaining}
                  total={creditsEntry?.size ?? state.total}
                  baseline={state.creditBaseline}
                  t={t}
                />
              ) : null}

              {state.perf !== undefined ? <PerfSection perf={state.perf} t={t} /> : null}

              {Array.isArray(state.models) && state.models.length > 0 ? (
                <ModelsSection
                  models={state.models}
                  busy={toggleBusy}
                  onToggle={handleToggleModel}
                  t={t}
                />
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
