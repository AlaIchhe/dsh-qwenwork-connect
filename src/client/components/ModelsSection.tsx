import { ModelList, type ModelBadge, type ModelListItem } from 'dsh-provider-ui';
import type { CardModelItem } from '../../shared/contracts.js';
import type { TranslateFn } from '../i18n.js';

export function ModelsSection(props: {
  readonly models: readonly CardModelItem[];
  readonly busy: boolean;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly onToggle: (model: CardModelItem) => void;
  readonly t: TranslateFn;
}) {
  const { models, busy, refreshing, onRefresh, onToggle, t } = props;
  const enabledCount = models.filter((m) => m.enabled !== false).length;

  const byId = new Map(models.map((m) => [m.id, m]));

  const items: ModelListItem[] = models.map((model) => {
    const enabled = model.enabled !== false;
    const canToggle = !enabled || enabledCount > 1;
    const badges: ModelBadge[] = [];
    if (model.isDefault) badges.push({ label: t('badgeDefault'), tone: 'brand' });
    if (model.isRecommended) badges.push({ label: t('badgeRecommended'), tone: 'ok' });
    if (model.isNew) badges.push({ label: t('badgeNew'), tone: 'warn' });

    return {
      id: model.id,
      name: model.name,
      description: model.description || undefined,
      enabled,
      disabled: !canToggle || busy,
      title: canToggle ? t('modelSwitchHint') : model.id,
      badges,
    };
  });

  return (
    <ModelList
      items={items}
      disabled={busy}
      hint={t('modelSwitchHint')}
      emptyText={t('noModels')}
      searchPlaceholder={t('searchModels')}
      onRefresh={onRefresh}
      refreshing={refreshing}
      refreshLabel={t('refresh')}
      refreshingLabel={t('refreshing')}
      switchAriaSuffix={t('modelSwitchLabel')}
      onToggle={(id) => {
        const target = byId.get(id);
        if (target && !busy) onToggle(target);
      }}
    />
  );
}
