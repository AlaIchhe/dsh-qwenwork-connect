import { SITE_IDS, type SiteId } from '../../shared/sites.js';
import { siteLabel, type TranslateFn } from '../i18n.js';
import { siteTabStyle, siteTabsStyle } from '../styles.js';

export function SiteTabs(props: {
  readonly active: SiteId;
  readonly onChange: (siteId: SiteId) => void;
  readonly t: TranslateFn;
}) {
  return (
    <div style={siteTabsStyle} role="tablist">
      {SITE_IDS.map((siteId) => (
        <button
          key={siteId}
          type="button"
          role="tab"
          aria-selected={siteId === props.active}
          style={siteTabStyle(siteId === props.active)}
          onClick={() => props.onChange(siteId)}
        >
          {siteLabel(props.t, siteId)}
        </button>
      ))}
    </div>
  );
}
