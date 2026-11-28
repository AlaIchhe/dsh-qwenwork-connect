import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  ConfirmButton,
  Notice,
  ProviderShell,
  SegmentedControl,
  StatusDot,
  Tag,
} from 'dsh-provider-ui';
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
  type PluginSettingsSnapshot,
  type SiteStatusResponse,
} from '../../shared/contracts.js';
import { SITE_CN, SITE_IDS, type SiteId } from '../../shared/sites.js';
import { siteLabel, type TranslateFn } from '../i18n.js';
import { fetchSiteStatus, patchSiteStatus, useSiteStatus } from '../store.js';
import { ModelsSection } from './ModelsSection.js';
import { PerfSection } from './PerfSection.js';
import { QuotaBar } from './QuotaBar.js';
import { SettingsSection } from './SettingsSection.js';

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
  const [tab, setTab] = useState<'account' | 'models' | 'advanced'>('account');
  const [activeSite, setActiveSite] = useState<SiteId>(props.initialSite ?? SITE_CN);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [login, setLogin] = useState<LocalLoginState | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const state = useSiteStatus(activeSite, true, {
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

  const handleSettingsSaved = (nextSettings: PluginSettingsSnapshot) => {
    for (const id of SITE_IDS) {
      patchSiteStatus(id, (prev) => (prev === null ? prev : { ...prev, settings: nextSettings }));
    }
  };

  const signedIn = state?.status === 'signed-in';
  const subtitleText =
    signedIn && state?.tierName
      ? `${siteLabel(t, activeSite)} · ${state.tierName}`
      : t('subtitle');

  const creditsEntry = state?.entitlements?.find((e) => e.key === 'credits');
  const remaining = state?.remaining ?? creditsEntry?.remain;
  const models = Array.isArray(state?.models) ? state.models : [];

  return (
    <ProviderShell
      title={t('title')}
      subtitle={subtitleText}
      activeTab={tab}
      onTabChange={setTab}
      headerExtra={
        <SegmentedControl
          value={activeSite}
          onChange={handleSwitchSite}
          options={SITE_IDS.map((siteId) => ({
            value: siteId,
            label: siteLabel(t, siteId),
          }))}
        />
      }
      tabs={[
        {
          id: 'account',
          label: t('tabAccount'),
          content: (
            <>
              {login !== null ? (
                <Notice kind={login.phase === 'failed' ? 'error' : 'busy'}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    <span>
                      {login.phase === 'failed' ? (login.error ?? t('loginFailed')) : t('loginWaiting')}
                    </span>
                    {login.phase === 'pending' && login.url ? (
                      <a
                        href={login.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--dsw-alias-brand-primary, #1677ff)', wordBreak: 'break-all' }}
                      >
                        {login.url}
                      </a>
                    ) : null}
                  </div>
                </Notice>
              ) : null}

              {logoutError !== null ? <Notice kind="error">{logoutError}</Notice> : null}

              {state !== null &&
              state.error !== undefined &&
              !(state.status === 'signed-out' && state.error.code === 'CREDENTIALS_MISSING') &&
              state.status !== 'signed-in' ? (
                <Notice kind="error">
                  {[state.error.message, state.error.recovery].filter(Boolean).join('\n')}
                </Notice>
              ) : null}

              <Card active={signedIn}>
                <div className="dpui-row-between">
                  <div className="dpui-row">
                    <StatusDot tone={signedIn ? 'ok' : 'idle'} />
                    <strong>
                      {state === null
                        ? t('loading')
                        : signedIn
                          ? t('signedInAs', { name: state.nickname ?? state.account ?? '—' })
                          : t('notSignedIn')}
                    </strong>
                    <Tag tone={signedIn ? 'ok' : 'default'}>
                      {signedIn ? t('signedIn') : t('notSignedIn')}
                    </Tag>
                  </div>
                  <div className="dpui-row">
                    {!signedIn ? (
                      <Button
                        variant="primary"
                        disabled={loginBusy || login?.phase === 'pending'}
                        onClick={handleStartLogin}
                      >
                        {loginBusy || login?.phase === 'pending' ? t('loggingIn') : t('login')}
                      </Button>
                    ) : (
                      <ConfirmButton
                        label={logoutBusy ? t('loggingOut') : t('logout')}
                        confirmLabel={t('confirmLogout')}
                        disabled={logoutBusy}
                        onConfirm={() => { void handleLogout(); }}
                      />
                    )}
                    <Button disabled={refreshBusy} onClick={() => { void handleRefresh(); }}>
                      {refreshBusy ? t('refreshing') : t('refresh')}
                    </Button>
                  </div>
                </div>

                {!signedIn && login === null ? (
                  <p className="dpui-muted">{t('loginHint')}</p>
                ) : null}

                {signedIn && typeof remaining === 'number' ? (
                  <QuotaBar
                    remaining={remaining}
                    total={creditsEntry?.size ?? state?.total}
                    baseline={state?.creditBaseline}
                    t={t}
                  />
                ) : null}

                {state?.perf !== undefined ? <PerfSection perf={state.perf} t={t} /> : null}
              </Card>
            </>
          ),
        },
        {
          id: 'models',
          label: t('tabModels'),
          badge: models.length > 0 ? String(models.length) : undefined,
          content: (
            <>
              {toggleError !== null ? <Notice kind="error">{toggleError}</Notice> : null}
              <ModelsSection
                models={models}
                busy={toggleBusy}
                refreshing={refreshBusy}
                onRefresh={() => { void handleRefresh(); }}
                onToggle={(model) => { void handleToggleModel(model); }}
                t={t}
              />
            </>
          ),
        },
        {
          id: 'advanced',
          label: t('tabAdvanced'),
          content: (
            <SettingsSection
              settings={state?.settings}
              onSaved={handleSettingsSaved}
              t={t}
            />
          ),
        },
      ]}
    />
  );
}
