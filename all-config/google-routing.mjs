// Unified-only exceptions: the same group handles Google sign-in, Antigravity
// and the narrowly scoped Google China domains before shared/direct matches.
export const GOOGLE_CORE_PROVIDER = 'unified-google-core';
const GOOGLE_GROUP = 'AI 美国';
const GOOGLE_DOH = ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'];
const GOOGLE_CORE_DOMAINS = [
  'accounts.google.com',
  'accounts.google.cn',
  'accounts.gstatic.com',
  'oauth2.googleapis.com',
  'oauthaccountmanager.googleapis.com',
  'ssl.gstatic.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'safebrowsing.googleapis.com',
  'dl.google.com',
  '+.googleapis.cn',
  '+.gstatic.cn',
  '+.antigravity.google',
  'antigravity.googleapis.com',
  'antigravity-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'daily-cloudcode-pa.googleapis.com',
  'businessaicode.googleapis.com',
  'businessaicode.us.rep.googleapis.com',
  'businessaicode.eu.rep.googleapis.com',
  'businessaicode.mtls.googleapis.com',
];

export function applyUnifiedGoogleRouting(config) {
  const rules = config.rules;
  const before = rules.indexOf('RULE-SET,jms-cn-ai-extra,DIRECT');
  const telemetryBlock = rules.indexOf('DOMAIN,play.googleapis.com,REJECT');
  if (before < 0 || telemetryBlock < 0 || telemetryBlock >= before ||
      !config['rule-providers'] || !config.dns?.['nameserver-policy'] ||
      !config['proxy-groups']?.some(group => group.name === GOOGLE_GROUP)) {
    throw new Error('Invalid hosted policy');
  }

  config['rule-providers'][GOOGLE_CORE_PROVIDER] = {
    type: 'inline',
    behavior: 'domain',
    payload: [...GOOGLE_CORE_DOMAINS],
  };
  // The paired reject follows the existing JMS convention: if no selected
  // proxy supports this transport, do not continue into a DIRECT rule.
  rules.splice(before, 0,
    `RULE-SET,${GOOGLE_CORE_PROVIDER},${GOOGLE_GROUP}`,
    `RULE-SET,${GOOGLE_CORE_PROVIDER},REJECT`);
  config.dns['nameserver-policy'] = {
    [`rule-set:${GOOGLE_CORE_PROVIDER}`]: GOOGLE_DOH.map(url => `${url}#${GOOGLE_GROUP}`),
    ...config.dns['nameserver-policy'],
  };
}
