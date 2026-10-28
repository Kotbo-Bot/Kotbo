import type { ActivityAnalytics } from '../../api';
import { m } from '../../i18n';
import type { ChartMetric } from './ActivityChartCard.svelte';
import { relativeDelta } from './analyticsFilters.svelte';
import { fmtMinutes, fmtNumber, SERIES } from './analyticsFormat';

/**
 * Tuiles de la carte de courbe tirées de /analytics/activity. Chaque vue
 * choisit les siennes par identifiant, dans l'ordre voulu ; une mesure garde
 * la même couleur partout où elle apparaît.
 */
export type ActivityMetricId = 'messages' | 'active' | 'per-active' | 'net-joins' | 'voice' | 'voice-per-active';

const ratio = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10) / 10 : 0);
export const fmtRatio = (v: number) => fmtNumber(Math.round(v * 10) / 10);

export function buildActivityMetrics(activity: ActivityAnalytics, ids: ActivityMetricId[]): ChartMetric[] {
  const k = activity.kpis;
  const series = activity.series;

  const build: Record<ActivityMetricId, () => ChartMetric | null> = {
    messages: () => ({
      id: 'messages',
      label: m.anx_metric_messages(),
      color: SERIES[0]!,
      format: fmtNumber,
      value: fmtNumber(k.messages.value),
      delta: relativeDelta(k.messages.value, k.messages.previous),
      previous: fmtNumber(k.messages.previous),
      aggregate: 'sum',
      daily: series.map((d) => d.messages),
      prevDaily: series.map((d) => d.prevMessages),
      hourly: (p) => p.messages,
      breakdown: 'messages',
      anomalyKey: 'messages',
      forecast: true,
    }),
    active: () => ({
      id: 'active',
      label: m.anx_metric_active(),
      hint: m.anx_metric_active_hint(),
      color: SERIES[6]!,
      format: fmtRatio,
      value: fmtNumber(k.activeMembers.value),
      delta: relativeDelta(k.activeMembers.value, k.activeMembers.previous),
      previous: fmtNumber(k.activeMembers.previous),
      aggregate: 'avg',
      daily: series.map((d) => d.activeMembers ?? 0),
      prevDaily: series.map((d) => d.prevActiveMembers ?? 0),
      hourly: (p) => p.activeMembers,
    }),
    'per-active': () => {
      const now = ratio(k.messages.value, k.activeMembers.value);
      const prev = ratio(k.messages.previous, k.activeMembers.previous);
      return {
        id: 'per-active',
        label: m.anx_metric_per_active(),
        hint: m.anx_metric_per_active_hint(),
        color: SERIES[4]!,
        format: fmtRatio,
        value: fmtRatio(now),
        delta: relativeDelta(now, prev),
        previous: fmtRatio(prev),
        aggregate: 'avg',
        daily: series.map((d) => ratio(d.messages, d.activeMembers ?? 0)),
        prevDaily: series.map((d) => ratio(d.prevMessages, d.prevActiveMembers ?? 0)),
        hourly: (p) => ratio(p.messages, p.activeMembers),
      };
    },
    'net-joins': () => ({
      id: 'net-joins',
      label: m.anx_metric_net_joins(),
      hint: m.anx_metric_net_joins_hint(),
      color: SERIES[3]!,
      format: fmtNumber,
      value: `${k.netJoins.value > 0 ? '+' : ''}${fmtNumber(k.netJoins.value)}`,
      delta: k.netJoins.previous > 0 ? relativeDelta(k.netJoins.value, k.netJoins.previous) : undefined,
      previous: `${k.netJoins.previous > 0 ? '+' : ''}${fmtNumber(k.netJoins.previous)}`,
      aggregate: 'sum',
      daily: series.map((d) => (d.joined ?? 0) - (d.left ?? 0)),
      prevDaily: series.map((d) => (d.prevJoined ?? 0) - (d.prevLeft ?? 0)),
    }),
    voice: () => (activity.voiceAvailable
      ? {
          id: 'voice',
          label: m.anx_metric_voice(),
          color: SERIES[2]!,
          format: fmtMinutes,
          value: fmtMinutes(k.voiceMinutes.value),
          delta: relativeDelta(k.voiceMinutes.value, k.voiceMinutes.previous),
          previous: fmtMinutes(k.voiceMinutes.previous),
          aggregate: 'sum',
          daily: series.map((d) => d.voiceMinutes),
          prevDaily: series.map((d) => d.prevVoiceMinutes),
          hourly: (p) => p.voiceMinutes,
          breakdown: 'voice',
          anomalyKey: 'voiceMinutes',
          forecast: true,
        }
      : null),
    'voice-per-active': () => {
      if (!activity.voiceAvailable) return null;
      const now = ratio(k.voiceMinutes.value, k.activeMembers.value);
      const prev = ratio(k.voiceMinutes.previous, k.activeMembers.previous);
      return {
        id: 'voice-per-active',
        label: m.anx_metric_voice_per_active(),
        hint: m.anx_metric_voice_per_active_hint(),
        color: SERIES[4]!,
        format: fmtMinutes,
        value: fmtMinutes(now),
        delta: relativeDelta(now, prev),
        previous: fmtMinutes(prev),
        aggregate: 'avg',
        daily: series.map((d) => ratio(d.voiceMinutes, d.activeMembers ?? 0)),
        prevDaily: series.map((d) => ratio(d.prevVoiceMinutes, d.prevActiveMembers ?? 0)),
        hourly: (p) => ratio(p.voiceMinutes, p.activeMembers),
      };
    },
  };

  return ids.map((id) => build[id]()).filter((metric): metric is ChartMetric => metric !== null);
}
