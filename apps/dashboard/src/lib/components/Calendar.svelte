<script lang="ts" module>
  /** Couleur de chaque type d'evenement, reprise par la legende de la page. */
  export const EVENT_TYPE_COLOR: Record<string, string> = {
    meeting: 'var(--color-primary)',
    call: 'var(--color-success)',
    absence: 'var(--color-warning)',
    task: 'var(--color-tertiary)',
    // Calques du serveur : couleurs de categorie, comme les calendriers d'Outlook.
    server_event: '#0891b2',
    giveaway: '#db2777',
    schedule: '#64748b',
  };

  export type CalendarView = 'day' | 'workweek' | 'week' | 'month' | 'agenda';

  export const CALENDAR_VIEWS: CalendarView[] = ['day', 'workweek', 'week', 'month', 'agenda'];

  export interface CalendarEvent {
    id: string;
    title: string;
    start: Date;
    end?: Date;
    type: string;
    isAllDay?: boolean;
    staffName?: string;
    avatarUrl?: string;
    details?: string;
    raw?: any;
  }
</script>

<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { layoutDay } from '../calendarLayout';
  import { m, dateLocale } from '../i18n';
  import Papicon from './Papicon.svelte';

  let {
    view = $bindable<CalendarView>('week'),
    currentDate = $bindable(new Date()),
    events = [] as CalendarEvent[],
    selectedKey = null as string | null,
    onRangeChange,
    onEventClick,
    onSlotSelect,
  }: {
    view?: CalendarView;
    currentDate?: Date;
    events?: CalendarEvent[];
    /** Evenement dont l'apercu est ouvert : reste en surbrillance. */
    selectedKey?: string | null;
    onRangeChange: (start: Date, end: Date) => void;
    onEventClick: (event: CalendarEvent, anchor: DOMRect) => void;
    /** Creneau choisi au clic ou au glisser ; `anchor` sert a placer la bulle de creation. */
    onSlotSelect: (start: Date, end: Date, anchor: DOMRect) => void;
  } = $props();

  const HOUR = 48;
  const DAY_HEIGHT = HOUR * 24;
  const WORK_START = 8;
  const WORK_END = 18;
  const SLOT = 30;

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const typeColor = (type: string) => EVENT_TYPE_COLOR[type] ?? 'var(--color-outline)';
  const keyOf = (e: CalendarEvent) => `${e.type}:${e.id}`;

  let timeGridEl = $state<HTMLElement | undefined>(undefined);
  let now = $state(new Date());

  // ── Jours affiches ──────────────────────────────────────
  function startOfDay(d: Date) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function addDays(d: Date, n: number) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function getMonday(d: Date) {
    const x = startOfDay(d);
    return addDays(x, -((x.getDay() + 6) % 7));
  }

  function isSameDay(a: Date, b: Date) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  const isToday = (d: Date) => isSameDay(d, now);
  const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;

  const days = $derived.by((): Date[] => {
    if (view === 'day') return [startOfDay(currentDate)];
    if (view === 'workweek') return Array.from({ length: 5 }, (_, i) => addDays(getMonday(currentDate), i));
    if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(getMonday(currentDate), i));
    const first = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    if (view === 'agenda') {
      const count = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0).getDate();
      return Array.from({ length: count }, (_, i) => addDays(first, i));
    }
    // Mois : six semaines pleines, du lundi au dimanche.
    return Array.from({ length: 42 }, (_, i) => addDays(getMonday(first), i));
  });

  const isTimeView = $derived(view === 'day' || view === 'workweek' || view === 'week');

  $effect(() => {
    const first = days[0];
    const last = days[days.length - 1];
    if (!first || !last) return;
    const end = new Date(last);
    end.setHours(23, 59, 59, 999);
    // Seule la periode relance l'effet, pas ce que la page lit en rechargeant.
    untrack(() => onRangeChange(first, end));
  });

  const title = $derived.by(() => {
    const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(dateLocale(), o);
    if (view === 'day') return capitalize(fmt(currentDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    if (view === 'month' || view === 'agenda') return capitalize(fmt(currentDate, { month: 'long', year: 'numeric' }));
    const first = days[0];
    const last = days[days.length - 1];
    if (first.getMonth() === last.getMonth()) return `${first.getDate()} – ${last.getDate()} ${fmt(last, { month: 'long', year: 'numeric' })}`;
    return `${fmt(first, { day: 'numeric', month: 'short' })} – ${fmt(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  });

  function shift(direction: 1 | -1) {
    if (view === 'day') currentDate = addDays(currentDate, direction);
    else if (view === 'week' || view === 'workweek') currentDate = addDays(currentDate, 7 * direction);
    else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + direction, 1);
  }

  function goToday() {
    currentDate = new Date();
    void tick().then(scrollToMorning);
  }

  // ── Evenements ──────────────────────────────────────────
  function eventEnd(e: CalendarEvent) {
    return e.end ?? new Date(e.start.getTime() + 3600000);
  }

  function eventsOn(day: Date) {
    const from = startOfDay(day).getTime();
    const to = from + 86400000;
    return events.filter((e) => {
      const s = e.start.getTime();
      const end = Math.max(eventEnd(e).getTime(), s + 1);
      return s < to && end > from;
    });
  }

  const allDayByDay = $derived(days.map((d) => eventsOn(d).filter((e) => e.isAllDay)));

  const timedByDay = $derived(
    days.map((day) => {
      const from = startOfDay(day).getTime();
      const items = eventsOn(day)
        .filter((e) => !e.isAllDay)
        .map((e) => {
          const startMin = Math.max(0, (e.start.getTime() - from) / 60000);
          const endMin = Math.min(1440, (eventEnd(e).getTime() - from) / 60000);
          return { event: e, key: keyOf(e), start: startMin, end: Math.max(endMin, startMin + 20) };
        });
      const layout = layoutDay(items);
      return items.map((item) => ({ ...item, ...layout.get(item.key)! }));
    }),
  );

  const agendaDays = $derived(
    view === 'agenda'
      ? days
          .map((date) => ({
            date,
            events: eventsOn(date).sort((a, b) => Number(!a.isAllDay) - Number(!b.isAllDay) || a.start.getTime() - b.start.getTime()),
          }))
          .filter((d) => d.events.length > 0)
      : [],
  );

  const formatTime = (d: Date) => d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  const isPast = (e: CalendarEvent) => eventEnd(e).getTime() < now.getTime();

  function getEventIcon(type: string) {
    switch (type) {
      case 'meeting': return 'calendar';
      case 'call': return 'phone';
      case 'absence': return 'sun';
      case 'task': return 'check-square';
      case 'server_event': return 'megaphone';
      case 'giveaway': return 'gift';
      case 'schedule': return 'send';
      default: return 'circle';
    }
  }

  function openEvent(event: CalendarEvent, target: EventTarget | null) {
    onEventClick(event, (target as HTMLElement).getBoundingClientRect());
  }

  // ── Selection de creneau ────────────────────────────────
  let selection = $state<{ day: number; from: number; to: number } | null>(null);

  function minutesAt(column: HTMLElement, clientY: number) {
    const rect = column.getBoundingClientRect();
    return Math.min(1440 - SLOT, Math.max(0, Math.floor(((clientY - rect.top) / HOUR) * 60 / SLOT) * SLOT));
  }

  function slotDate(day: Date, minutes: number) {
    const d = startOfDay(day);
    d.setMinutes(minutes);
    return d;
  }

  function finishSelection(column: HTMLElement) {
    if (!selection) return;
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to) + SLOT;
    const rect = column.getBoundingClientRect();
    const anchor = new DOMRect(rect.left, rect.top + (from / 60) * HOUR, rect.width, ((to - from) / 60) * HOUR);
    onSlotSelect(slotDate(days[selection.day], from), slotDate(days[selection.day], to), anchor);
  }

  function handleColumnPointerDown(dayIndex: number, event: PointerEvent) {
    if (event.button !== 0) return;
    const column = event.currentTarget as HTMLElement;
    const start = minutesAt(column, event.clientY);
    selection = { day: dayIndex, from: start, to: start };

    // Au doigt, un glisser fait defiler la grille : seul un appui bref choisit le creneau.
    if (event.pointerType !== 'mouse') {
      const x = event.clientX;
      const y = event.clientY;
      const up = (e: PointerEvent) => {
        window.removeEventListener('pointerup', up);
        if (Math.hypot(e.clientX - x, e.clientY - y) <= 10) finishSelection(column);
        selection = null;
      };
      window.addEventListener('pointerup', up);
      return;
    }

    event.preventDefault();
    const move = (e: PointerEvent) => {
      if (selection) selection = { ...selection, to: minutesAt(column, e.clientY) };
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      finishSelection(column);
      selection = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function handleColumnKeydown(day: Date, event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const start = slotDate(day, 9 * 60);
    onSlotSelect(start, new Date(start.getTime() + 3600000), (event.currentTarget as HTMLElement).getBoundingClientRect());
  }

  function selectAllDay(day: Date, target: EventTarget | null) {
    const start = slotDate(day, 9 * 60);
    onSlotSelect(start, new Date(start.getTime() + 3600000), (target as HTMLElement).getBoundingClientRect());
  }

  function openDay(day: Date) {
    currentDate = new Date(day);
    view = 'day';
  }

  // ── Defilement et raccourcis ────────────────────────────
  function scrollToMorning() {
    if (!timeGridEl) return;
    const hour = isToday(currentDate) || days.some(isToday) ? Math.max(0, Math.min(now.getHours() - 2, 17)) : WORK_START;
    timeGridEl.scrollTop = Math.max(hour, 0) * HOUR;
  }

  $effect(() => {
    if (isTimeView) void tick().then(scrollToMorning);
  });

  const VIEW_KEYS: Record<string, CalendarView> = { d: 'day', w: 'week', m: 'month', a: 'agenda' };

  // ← → pour naviguer, T pour aujourd'hui, D/W/M/A pour la vue.
  // Ignore pendant une saisie et quand une fenetre est ouverte par-dessus.
  function handleShortcut(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('[role="dialog"]')) return;
    const key = e.key.toLowerCase();
    if (e.key === 'ArrowLeft') shift(-1);
    else if (e.key === 'ArrowRight') shift(1);
    else if (key === 't') goToday();
    else if (VIEW_KEYS[key]) view = VIEW_KEYS[key];
    else return;
    e.preventDefault();
  }

  onMount(() => {
    // Sur telephone, une liste se lit mieux qu'une grille de sept colonnes.
    if (window.matchMedia('(max-width: 640px)').matches && (view === 'week' || view === 'workweek')) view = 'agenda';
    const clock = setInterval(() => (now = new Date()), 60000);
    window.addEventListener('keydown', handleShortcut);
    return () => {
      clearInterval(clock);
      window.removeEventListener('keydown', handleShortcut);
    };
  });
</script>

{#snippet eventChip(event: CalendarEvent, compact: boolean)}
  <button
    type="button"
    class="cal-chip {selectedKey === keyOf(event) ? 'cal-chip--selected' : ''} {isPast(event) ? 'cal-chip--past' : ''}"
    style="--evt: {typeColor(event.type)}"
    onclick={(e) => { e.stopPropagation(); openEvent(event, e.currentTarget); }}
    onpointerdown={(e) => e.stopPropagation()}
  >
    {#if !compact && !event.isAllDay}
      <span class="cal-chip__time">{formatTime(event.start)}</span>
    {/if}
    <span class="cal-chip__title">{event.title}</span>
  </button>
{/snippet}

<section class="cal flex flex-col h-full min-h-0" aria-label={title}>
  <!-- Barre de navigation : Aujourd'hui, precedent / suivant, periode -->
  <div class="cal-nav flex items-center gap-1 px-3 py-2 border-b border-outline-variant shrink-0">
    <button type="button" class="cal-nav__today" onclick={goToday} title="{m.cal_today()} (T)">{m.cal_today()}</button>
    <button type="button" class="cal-nav__arrow" onclick={() => shift(-1)} aria-label={m.cal_prev()} title="{m.cal_prev()} (←)">
      <Papicon icon="chevron-left" size={16} />
    </button>
    <button type="button" class="cal-nav__arrow" onclick={() => shift(1)} aria-label={m.cal_next()} title="{m.cal_next()} (→)">
      <Papicon icon="chevron-right" size={16} />
    </button>
    <h2 class="ml-2 min-w-0 truncate text-base font-semibold text-on-surface">{title}</h2>
  </div>

  <div class="flex-1 min-h-0 flex flex-col">
    {#if view === 'agenda'}
      <div class="flex-1 overflow-y-auto">
        {#each agendaDays as day (day.date.getTime())}
          <section>
            <h3 class="sticky top-0 z-10 px-4 py-2 text-body-sm font-semibold bg-surface-container-low border-b border-outline-variant {isToday(day.date) ? 'text-primary' : 'text-on-surface'}">
              {capitalize(day.date.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' }))}
              {#if isToday(day.date)}<span class="ml-1 text-2xs font-medium">· {m.cal_today()}</span>{/if}
            </h3>
            <ul>
              {#each day.events as event (keyOf(event))}
                <li>
                  <button
                    type="button"
                    onclick={(e) => openEvent(event, e.currentTarget)}
                    style="--evt: {typeColor(event.type)}"
                    class="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-container transition-colors {isPast(event) ? 'opacity-60' : ''}"
                  >
                    <span class="w-28 shrink-0 text-2xs font-medium text-on-surface-variant tabular-nums">
                      {event.isAllDay ? m.cal_all_day() : `${formatTime(event.start)} – ${formatTime(eventEnd(event))}`}
                    </span>
                    <span class="cal-bar self-stretch"></span>
                    <span class="min-w-0 flex-1">
                      <span class="block text-body-sm font-medium text-on-surface truncate">{event.title}</span>
                      {#if event.staffName}
                        <span class="block text-2xs text-on-surface-variant truncate">{event.staffName}</span>
                      {/if}
                    </span>
                    <Papicon icon={getEventIcon(event.type)} size={14} class="text-on-surface-variant shrink-0" />
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {:else}
          <div class="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
            <Papicon icon="calendar" size={28} class="text-on-surface-variant" />
            <p class="text-body-sm text-on-surface-variant">{m.cal_agenda_empty()}</p>
            <button
              type="button"
              class="btn btn-tonal btn-sm"
              onclick={(e) => { const s = new Date(Date.now() + 3600000); onSlotSelect(s, new Date(s.getTime() + 3600000), e.currentTarget.getBoundingClientRect()); }}
            >
              {m.cal_agenda_add()}
            </button>
          </div>
        {/each}
      </div>
    {:else if view === 'month'}
      <div class="grid grid-cols-7 border-b border-outline-variant shrink-0">
        {#each days.slice(0, 7) as d (d.getTime())}
          <div class="px-2 py-1.5 text-2xs font-semibold text-on-surface-variant">
            {capitalize(d.toLocaleDateString(dateLocale(), { weekday: 'long' }))}
          </div>
        {/each}
      </div>
      <div class="flex-1 min-h-0 grid grid-cols-7 grid-rows-6">
        {#each days as day, i (day.getTime())}
          {@const dayEvents = eventsOn(day).sort((a, b) => Number(!a.isAllDay) - Number(!b.isAllDay) || a.start.getTime() - b.start.getTime())}
          <div
            class="cal-month-cell {day.getMonth() !== currentDate.getMonth() ? 'cal-month-cell--out' : ''} {isWeekend(day) ? 'cal-off' : ''}"
            role="button"
            tabindex="0"
            aria-label={day.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}
            onclick={(e) => selectAllDay(day, e.currentTarget)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), selectAllDay(day, e.currentTarget))}
          >
            <button
              type="button"
              class="cal-month-day {isToday(day) ? 'cal-month-day--today' : ''}"
              onclick={(e) => { e.stopPropagation(); openDay(day); }}
            >
              {day.getDate() === 1 || i === 0 ? day.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' }) : day.getDate()}
            </button>
            <div class="flex flex-col gap-0.5 min-w-0">
              {#each dayEvents.slice(0, 3) as event (keyOf(event))}
                {@render eventChip(event, false)}
              {/each}
              {#if dayEvents.length > 3}
                <button type="button" class="cal-more" onclick={(e) => { e.stopPropagation(); openDay(day); }}>
                  {m.cal_more({ n: dayEvents.length - 3 })}
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {:else}
      <!-- En-tetes des jours -->
      <div class="cal-row border-b border-outline-variant shrink-0" style="--cols: {days.length}">
        <div></div>
        {#each days as day (day.getTime())}
          <button type="button" class="cal-day-head {isToday(day) ? 'cal-day-head--today' : ''}" onclick={() => openDay(day)}>
            <span class="cal-day-head__num">{day.getDate()}</span>
            <span class="cal-day-head__name">{day.toLocaleDateString(dateLocale(), { weekday: view === 'day' ? 'long' : 'short' })}</span>
          </button>
        {/each}
      </div>

      <!-- Evenements sur la journee entiere -->
      <div class="cal-row border-b border-outline-variant shrink-0" style="--cols: {days.length}">
        <div class="cal-gutter-label">{m.cal_all_day()}</div>
        {#each days as day, i (day.getTime())}
          <div
            class="cal-allday"
            role="button"
            tabindex="-1"
            onclick={(e) => selectAllDay(day, e.currentTarget)}
            onkeydown={() => {}}
          >
            {#each allDayByDay[i].slice(0, 3) as event (keyOf(event))}
              {@render eventChip(event, true)}
            {/each}
            {#if allDayByDay[i].length > 3}
              <button type="button" class="cal-more" onclick={(e) => { e.stopPropagation(); openDay(day); }}>
                {m.cal_more({ n: allDayByDay[i].length - 3 })}
              </button>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Grille horaire -->
      <div bind:this={timeGridEl} class="flex-1 min-h-0 overflow-y-auto">
        <div class="cal-row relative" style="--cols: {days.length}; height: {DAY_HEIGHT}px">
          <div class="relative">
            {#each hours as hour (hour)}
              {#if hour > 0}
                <span class="cal-hour" style="top: {hour * HOUR}px">{String(hour).padStart(2, '0')}:00</span>
              {/if}
            {/each}
          </div>

          {#each days as day, i (day.getTime())}
            <div
              class="cal-col"
              role="button"
              tabindex="0"
              aria-label={day.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}
              onpointerdown={(e) => handleColumnPointerDown(i, e)}
              onkeydown={(e) => handleColumnKeydown(day, e)}
            >
              {#each hours as hour (hour)}
                <div class="cal-hour-cell {isWeekend(day) || hour < WORK_START || hour >= WORK_END ? 'cal-off' : ''}"></div>
              {/each}

              {#if selection && selection.day === i}
                {@const from = Math.min(selection.from, selection.to)}
                {@const to = Math.max(selection.from, selection.to) + SLOT}
                <div class="cal-selection" style="top: {(from / 60) * HOUR}px; height: {((to - from) / 60) * HOUR}px">
                  {formatTime(slotDate(day, from))} – {formatTime(slotDate(day, to))}
                </div>
              {/if}

              {#each timedByDay[i] as item (item.key)}
                {@const height = ((item.end - item.start) / 60) * HOUR}
                <button
                  type="button"
                  class="cal-event {selectedKey === item.key ? 'cal-event--selected' : ''} {isPast(item.event) ? 'cal-event--past' : ''}"
                  style="--evt: {typeColor(item.event.type)}; top: {(item.start / 60) * HOUR}px; height: {height - 2}px; left: calc({(item.col / item.cols) * 100}% + 1px); width: calc({100 / item.cols}% - 4px);"
                  onclick={(e) => { e.stopPropagation(); openEvent(item.event, e.currentTarget); }}
                  onpointerdown={(e) => e.stopPropagation()}
                >
                  <span class="cal-event__title">{item.event.title}</span>
                  {#if height >= 36}
                    <span class="cal-event__meta">{formatTime(item.event.start)} – {formatTime(eventEnd(item.event))}</span>
                  {/if}
                  {#if height >= 56 && item.event.staffName}
                    <span class="cal-event__meta">{item.event.staffName}</span>
                  {/if}
                </button>
              {/each}

              {#if isToday(day)}
                <div class="cal-now" style="top: {((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR}px" aria-hidden="true"></div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .cal-nav__today {
    padding: 0.375rem 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--color-on-surface);
  }
  .cal-nav__today:hover,
  .cal-nav__arrow:hover {
    background: var(--color-surface-container);
  }
  .cal-nav__arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 0.375rem;
    color: var(--color-on-surface-variant);
  }

  .cal-row {
    display: grid;
    grid-template-columns: 3.5rem repeat(var(--cols), minmax(0, 1fr));
  }
  .cal-day-head {
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
    padding: 0.5rem 0.625rem;
    border-left: 1px solid var(--color-outline-variant);
    text-align: left;
    color: var(--color-on-surface);
    position: relative;
  }
  .cal-day-head:hover {
    background: var(--color-surface-container);
  }
  .cal-day-head__num {
    font-size: 1.375rem;
    font-weight: 600;
    line-height: 1;
  }
  .cal-day-head__name {
    font-size: 0.8125rem;
    color: var(--color-on-surface-variant);
  }
  .cal-day-head--today {
    color: var(--color-primary);
  }
  .cal-day-head--today .cal-day-head__name {
    color: var(--color-primary);
  }
  .cal-day-head--today::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 3px;
    background: var(--color-primary);
  }
  .cal-gutter-label {
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: 0.375rem 0.5rem 0 0;
    font-size: 0.6875rem;
    color: var(--color-on-surface-variant);
  }
  .cal-allday {
    min-height: 2rem;
    padding: 0.125rem;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    border-left: 1px solid var(--color-outline-variant);
    min-width: 0;
    cursor: pointer;
  }

  .cal-hour {
    position: absolute;
    right: 0.5rem;
    transform: translateY(-50%);
    font-size: 0.6875rem;
    color: var(--color-on-surface-variant);
    font-variant-numeric: tabular-nums;
  }
  .cal-col {
    position: relative;
    border-left: 1px solid var(--color-outline-variant);
    cursor: default;
    user-select: none;
    touch-action: pan-y;
  }
  .cal-hour-cell {
    height: 48px;
    border-bottom: 1px solid color-mix(in srgb, var(--color-outline-variant) 70%, transparent);
    background-image: linear-gradient(to bottom, transparent 23.5px, color-mix(in srgb, var(--color-outline-variant) 35%, transparent) 23.5px, transparent 24.5px);
  }
  /* Heures hors bureau et week-end : un ton plus sombre, comme Outlook. */
  .cal-off {
    background-color: color-mix(in srgb, var(--color-surface-container) 55%, transparent);
  }
  .cal-selection {
    position: absolute;
    left: 2px;
    right: 2px;
    z-index: 2;
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--color-primary) 18%, transparent);
    border: 1px solid var(--color-primary);
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--color-primary);
    pointer-events: none;
  }

  .cal-event {
    position: absolute;
    z-index: 3;
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    overflow: hidden;
    padding: 0.1875rem 0.375rem 0.1875rem 0.5rem;
    border-radius: 0.25rem;
    border-left: 3px solid var(--evt);
    background: color-mix(in srgb, var(--evt) 18%, var(--color-surface-container-lowest));
    text-align: left;
    color: var(--color-on-surface);
    transition: background-color 0.12s ease, box-shadow 0.12s ease;
  }
  .cal-event:hover {
    background: color-mix(in srgb, var(--evt) 28%, var(--color-surface-container-lowest));
    z-index: 4;
  }
  .cal-event--selected {
    background: var(--evt);
    color: var(--color-on-primary);
    box-shadow: 0 4px 12px rgb(0 0 0 / 0.25);
    z-index: 5;
  }
  .cal-event--selected .cal-event__meta {
    color: inherit;
  }
  .cal-event--past {
    opacity: 0.6;
  }
  .cal-event__title {
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cal-event__meta {
    font-size: 0.6875rem;
    color: var(--color-on-surface-variant);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cal-now {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 6;
    height: 2px;
    background: var(--color-error);
    pointer-events: none;
  }
  .cal-now::before {
    content: '';
    position: absolute;
    left: -5px;
    top: -4px;
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--color-error);
  }

  .cal-chip {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    padding: 0.0625rem 0.375rem;
    border-radius: 0.25rem;
    border-left: 3px solid var(--evt);
    background: color-mix(in srgb, var(--evt) 16%, var(--color-surface-container-lowest));
    font-size: 0.6875rem;
    text-align: left;
    color: var(--color-on-surface);
  }
  .cal-chip:hover {
    background: color-mix(in srgb, var(--evt) 26%, var(--color-surface-container-lowest));
  }
  .cal-chip--selected {
    background: var(--evt);
    color: var(--color-on-primary);
  }
  .cal-chip--past {
    opacity: 0.6;
  }
  .cal-chip__time {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
  }
  .cal-chip__title {
    min-width: 0;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cal-more {
    padding: 0 0.375rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-align: left;
    color: var(--color-primary);
  }
  .cal-more:hover {
    text-decoration: underline;
  }

  .cal-month-cell {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    padding: 0.25rem;
    border-left: 1px solid var(--color-outline-variant);
    border-bottom: 1px solid var(--color-outline-variant);
    cursor: pointer;
  }
  .cal-month-cell:hover {
    background-color: var(--color-surface-container);
  }
  .cal-month-cell--out .cal-month-day {
    color: var(--color-on-surface-variant);
  }
  .cal-month-day {
    align-self: flex-start;
    min-width: 1.5rem;
    height: 1.5rem;
    padding: 0 0.375rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-on-surface);
  }
  .cal-month-day:hover {
    background: var(--color-surface-container-high);
  }
  .cal-month-day--today {
    background: var(--color-primary);
    color: var(--color-on-primary);
  }
  .cal-month-day--today:hover {
    background: var(--color-primary);
  }
  .cal-bar {
    width: 3px;
    border-radius: 2px;
    background: var(--evt);
  }
</style>
