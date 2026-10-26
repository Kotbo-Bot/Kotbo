<script lang="ts" module>
  /** Couleur de chaque type d'evenement, reprise par la legende de la page. */
  export const EVENT_TYPE_COLOR: Record<string, string> = {
    meeting: 'var(--color-primary)',
    call: 'var(--color-success)',
    absence: 'var(--color-warning)',
    task: 'var(--color-tertiary)',
  };
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { m, dateLocale } from '../i18n';
  import Papicon from './Papicon.svelte';

  interface CalendarEvent {
    id: string;
    title: string;
    start: Date;
    end?: Date;
    color?: string;
    icon?: string;
    type: string;
    isAllDay?: boolean;
    staffName?: string;
    avatarUrl?: string;
    details?: string;
    raw?: any;
  }

  type ViewType = 'day' | 'workweek' | 'week' | 'month' | 'agenda';

  let { view = $bindable('week'), currentDate = $bindable(new Date()), events = [], onRangeChange, onEventClick, onDateClick } = $props();

  let isSelecting = $state(false);
  let selectionStart = $state<{ date: Date, minutes: number } | null>(null);
  let selectionEnd = $state<{ date: Date, minutes: number } | null>(null);
  let timeGridEl = $state<HTMLElement | undefined>(undefined);
  let isNarrow = $state(false);

  // Lundi 1er janvier 2024 : sert seulement a nommer les jours dans la langue choisie.
  const weekDaysShort = Array.from({ length: 7 }, (_, i) =>
    capitalize(new Date(2024, 0, 1 + i).toLocaleDateString(dateLocale(), { weekday: 'short' }).replace('.', '')),
  );
  const hours = Array.from({ length: 24 }, (_, i) => i);
  function capitalize(s: string) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  const viewTabs: { key: ViewType; label: () => string; short?: () => string }[] = [
    { key: 'day', label: m.cal_view_day },
    { key: 'workweek', label: m.cal_view_workweek, short: m.cal_view_workweek_short },
    { key: 'week', label: m.cal_view_week },
    { key: 'month', label: m.cal_view_month },
    { key: 'agenda', label: m.cal_view_agenda },
  ];

  const typeColor = (type: string) => EVENT_TYPE_COLOR[type] ?? 'var(--color-outline)';

  function getMonday(d: Date): Date {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    date.setDate(diff);
    return date;
  }

  function getDaysForView(date: Date, v: ViewType) {
    if (v === 'day') {
      return [{ date: new Date(date), isCurrentMonth: true }];
    }

    if (v === 'workweek') {
      const monday = getMonday(new Date(date));
      return Array.from({ length: 5 }, (_, i) => {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        return { date: d, isCurrentMonth: true };
      });
    }

    if (v === 'week') {
      const monday = getMonday(new Date(date));
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        return { date: d, isCurrentMonth: d.getMonth() === date.getMonth() };
      });
    }

    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const offset = firstDay === 0 ? 6 : firstDay - 1;
    const days: { date: Date; isCurrentMonth: boolean }[] = [];

    const prevMonthDays = new Date(year, month, 0).getDate();
    for (let i = offset - 1; i >= 0; i--) {
      days.push({ date: new Date(year, month - 1, prevMonthDays - i), isCurrentMonth: false });
    }
    for (let i = 1; i <= daysInMonth; i++) {
      days.push({ date: new Date(year, month, i), isCurrentMonth: true });
    }
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      days.push({ date: new Date(year, month + 1, i), isCurrentMonth: false });
    }
    // L'agenda couvre le mois affiche, sans les jours de bordure de la grille.
    return v === 'agenda' ? days.filter((d) => d.isCurrentMonth) : days;
  }

  const calendarDays = $derived(getDaysForView(currentDate, view as ViewType));
  const isTimeView = $derived(view !== 'month' && view !== 'agenda');
  const colCount = $derived(calendarDays.length);

  const headerTitle = $derived.by(() => {
    if (view === 'day') {
      return capitalize(currentDate.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    }
    if (view === 'workweek' || view === 'week') {
      const first = calendarDays[0]?.date;
      const last = calendarDays[calendarDays.length - 1]?.date;
      if (!first || !last) return '';
      if (first.getMonth() === last.getMonth()) {
        return `${first.getDate()} – ${last.getDate()} ${capitalize(last.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' }))}`;
      }
      return `${first.getDate()} ${capitalize(first.toLocaleDateString(dateLocale(), { month: 'short' }))} – ${last.getDate()} ${capitalize(last.toLocaleDateString(dateLocale(), { month: 'short', year: 'numeric' }))}`;
    }
    return capitalize(currentDate.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' }));
  });

  /** Jours du mois qui ont au moins un evenement, pour la vue Agenda. */
  const agendaDays = $derived(
    view === 'agenda'
      ? calendarDays
          .map(({ date }) => ({
            date,
            events: getEventsForDate(date).sort(
              (a: CalendarEvent, b: CalendarEvent) =>
                Number(!a.isAllDay) - Number(!b.isAllDay) || new Date(a.start).getTime() - new Date(b.start).getTime(),
            ),
          }))
          .filter((day) => day.events.length > 0)
      : [],
  );

  function next() {
    if (view === 'day') currentDate = new Date(currentDate.getTime() + 86400000);
    else if (view === 'workweek' || view === 'week') currentDate = new Date(currentDate.getTime() + 7 * 86400000);
    else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
    updateRange();
  }

  function prev() {
    if (view === 'day') currentDate = new Date(currentDate.getTime() - 86400000);
    else if (view === 'workweek' || view === 'week') currentDate = new Date(currentDate.getTime() - 7 * 86400000);
    else currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1);
    updateRange();
  }

  function today() {
    currentDate = new Date();
    updateRange();
  }

  function updateRange() {
    if (!calendarDays.length) return;
    const start = new Date(calendarDays[0].date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(calendarDays[calendarDays.length - 1].date);
    end.setHours(23, 59, 59, 999);
    onRangeChange(start, end);
  }

  function isToday(date: Date) {
    const t = new Date();
    return date.getDate() === t.getDate() && date.getMonth() === t.getMonth() && date.getFullYear() === t.getFullYear();
  }

  function getEventIcon(type: string) {
    switch (type) {
      case 'meeting': return 'calendar';
      case 'call': return 'phone';
      case 'absence': return 'sun';
      case 'task': return 'check-square';
      case 'vocal': return 'mic';
      default: return 'circle';
    }
  }

  function formatTime(date: Date | string) {
    return new Date(date).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  }

  function getEventStyles(event: CalendarEvent, dayEvents: CalendarEvent[]) {
    const start = new Date(event.start);
    const end = event.end ? new Date(event.end) : new Date(start.getTime() + 3600000);
    if (isNaN(start.getTime())) return { top: 0, height: 0, width: 0, left: 0 };

    const startMinutes = start.getHours() * 60 + start.getMinutes();
    const isSameDayEvt = end.toDateString() === start.toDateString();
    const endMinutes = isSameDayEvt ? end.getHours() * 60 + end.getMinutes() : 24 * 60;
    const duration = Math.max(endMinutes - startMinutes, 20);

    const timedEvents = dayEvents
      .filter(e => !e.isAllDay)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    const overlapping = timedEvents.filter(e => {
      const eStart = new Date(e.start).getTime();
      const eEnd = e.end ? new Date(e.end).getTime() : eStart + 3600000;
      return eStart < end.getTime() && eEnd > start.getTime();
    });

    const index = overlapping.findIndex(e => e.id === event.id);
    const count = Math.max(overlapping.length, 1);
    const safeIndex = index === -1 ? 0 : index;

    return {
      top: (startMinutes / (24 * 60)) * 100,
      height: (duration / (24 * 60)) * 100,
      width: 100 / count,
      left: safeIndex * (100 / count)
    };
  }

  function getEventsForDate(date: Date, type: 'all' | 'allDay' | 'timed' = 'all') {
    const dayEvents = events.filter((e: CalendarEvent) => {
      const start = new Date(e.start);
      const end = e.end ? new Date(e.end) : start;
      const d = new Date(date); d.setHours(0, 0, 0, 0);
      const s = new Date(start); s.setHours(0, 0, 0, 0);
      const ed = new Date(end); ed.setHours(0, 0, 0, 0);
      return d >= s && d <= ed;
    });
    if (type === 'allDay') return dayEvents.filter(e => e.isAllDay);
    if (type === 'timed') return dayEvents.filter(e => !e.isAllDay);
    return dayEvents;
  }

  function getGlobalTimeTop() {
    const now = new Date();
    return ((now.getHours() * 60 + now.getMinutes()) / (24 * 60)) * 100;
  }

  function handlePointerDown(date: Date, e: PointerEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = e.clientY - rect.top;

    let minutes = 0;
    if (isTimeView) {
      minutes = Math.floor(((y / rect.height) * (24 * 60)) / 30) * 30;
    }

    if (e.pointerType !== 'mouse') {
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;

      const cleanup = () => {
        window.removeEventListener('pointerup', onTouchEnd);
        window.removeEventListener('pointercancel', cleanup);
      };

      const onTouchEnd = (endEvent: PointerEvent) => {
        if (endEvent.pointerId !== pointerId) return;
        cleanup();
        if (Math.hypot(endEvent.clientX - startX, endEvent.clientY - startY) > 10) return;

        const tappedMinutes = isTimeView
          ? Math.floor((((endEvent.clientY - rect.top) / rect.height) * (24 * 60)) / 30) * 30
          : 0;
        const start = new Date(date);
        start.setHours(Math.floor(tappedMinutes / 60), tappedMinutes % 60, 0, 0);
        if (isTimeView) {
          onDateClick(start, new Date(start.getTime() + 30 * 60 * 1000));
        } else {
          onDateClick(start);
        }
      };

      window.addEventListener('pointerup', onTouchEnd);
      window.addEventListener('pointercancel', cleanup);
      return;
    }

    isSelecting = true;
    selectionStart = { date, minutes };
    selectionEnd = { date, minutes: isTimeView ? minutes + 30 : 1410 };

    const cellClass = isTimeView ? '.day-column' : '.month-day';

    const onMove = (me: PointerEvent) => {
      if (!isSelecting || !selectionStart) return;
      const el = document.elementFromPoint(me.clientX, me.clientY);
      const cell = el?.closest(cellClass) as HTMLElement;
      if (!cell) return;
      const cells = Array.from(document.querySelectorAll(cellClass));
      const idx = cells.indexOf(cell);
      if (idx === -1) return;

      const colDate = calendarDays[idx].date;
      if (isTimeView) {
        const colRect = cell.getBoundingClientRect();
        const colY = me.clientY - colRect.top;
        const colMinutes = Math.floor(((colY / colRect.height) * (24 * 60)) / 30) * 30;
        selectionEnd = { date: colDate, minutes: colMinutes };
      } else {
        selectionEnd = { date: colDate, minutes: 1410 };
      }
    };

    const onUp = () => {
      if (isSelecting && selectionStart && selectionEnd) {
        let start = new Date(selectionStart.date);
        let end = new Date(selectionEnd.date);

        if (start > end) {
          [start, end] = [end, start];
          const tmp = selectionStart;
          selectionStart = { date: selectionEnd.date, minutes: selectionEnd.minutes };
          selectionEnd = { date: tmp.date, minutes: tmp.minutes };
        }

        const startDate = new Date(start);
        startDate.setHours(Math.floor(selectionStart.minutes / 60), selectionStart.minutes % 60, 0, 0);
        const endDate = new Date(end);
        endDate.setHours(Math.floor(selectionEnd.minutes / 60), selectionEnd.minutes % 60, 0, 0);

        onDateClick(startDate, endDate);
      }
      isSelecting = false;
      selectionStart = null;
      selectionEnd = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function scrollToCurrentTime() {
    if (!timeGridEl) return;
    const now = new Date();
    const h = (now.getHours() >= 7 && now.getHours() <= 20) ? Math.max(now.getHours() - 2, 0) : 7;
    timeGridEl.scrollTop = h * 60;
  }

  $effect(() => {
    if (view) {
      updateRange();
    }
  });

  $effect(() => {
    const v = view;
    if (v !== 'month') {
      tick().then(scrollToCurrentTime);
    }
  });

  const VIEW_KEYS: Record<string, ViewType> = { d: 'day', w: 'week', m: 'month', a: 'agenda' };

  // ← → pour naviguer, T pour revenir a aujourd'hui, D/W/M/A pour la vue.
  // Ignore pendant une saisie et quand une fenetre est ouverte par-dessus.
  function handleShortcut(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('[role="dialog"]')) return;
    const key = e.key.toLowerCase();
    if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'ArrowRight') next();
    else if (key === 't') today();
    else if (VIEW_KEYS[key]) view = VIEW_KEYS[key];
    else return;
    e.preventDefault();
  }

  onMount(() => {
    const narrowQuery = window.matchMedia('(max-width: 640px)');
    const syncNarrowView = () => {
      isNarrow = narrowQuery.matches;
      // Sur telephone, une liste se lit mieux qu'une grille de sept colonnes.
      if (isNarrow && (view === 'week' || view === 'workweek')) {
        view = 'agenda';
      }
      updateRange();
    };

    syncNarrowView();
    narrowQuery.addEventListener('change', syncNarrowView);
    window.addEventListener('keydown', handleShortcut);
    return () => {
      narrowQuery.removeEventListener('change', syncNarrowView);
      window.removeEventListener('keydown', handleShortcut);
    };
  });
</script>

<div class="calendar-container flex flex-col bg-surface-container-low rounded-xl border border-outline-variant/30 overflow-hidden shadow-sm" style="height: 75vh; min-height: 600px;">
  <!-- Outlook-style Header -->
  <header class="calendar-header px-5 py-3 border-b border-outline-variant/20 flex items-center justify-between bg-surface-container-lowest shrink-0">
    <div class="calendar-header__leading flex items-center gap-3">
      <!-- Navigation -->
      <div class="flex items-center gap-0.5">
        <button onclick={prev} class="w-8 h-8 flex items-center justify-center rounded-md hover:bg-surface-hover transition-colors" aria-label={m.cal_prev()} title="{m.cal_prev()} (←)">
          <Papicon icon="chevron-left" size={16} />
        </button>
        <button onclick={next} class="w-8 h-8 flex items-center justify-center rounded-md hover:bg-surface-hover transition-colors" aria-label={m.cal_next()} title="{m.cal_next()} (→)">
          <Papicon icon="chevron-right" size={16} />
        </button>
      </div>
      <button onclick={today} title="{m.cal_today()} (T)" class="px-3 py-1.5 text-2xs font-semibold text-on-surface-variant hover:text-on-surface hover:bg-surface-hover rounded-md border border-outline-variant transition-all">
        {m.cal_today()}
      </button>

      <!-- Title -->
      <h2 class="calendar-header__title text-base font-semibold text-on-surface ml-1">{headerTitle}</h2>
    </div>

    <!-- View Tabs (Outlook-style) -->
    <div class="calendar-view-tabs flex bg-surface-container/50 p-0.5 rounded-lg border border-outline-variant/15">
      {#each viewTabs as { key, label, short }}
        <button
          onclick={() => view = key}
          aria-pressed={view === key}
          class="px-3 py-1.5 text-2xs font-semibold rounded-md transition-all whitespace-nowrap {view === key ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-hover'}"
        >
          {isNarrow && short ? short() : label()}
        </button>
      {/each}
    </div>
  </header>

  <!-- Calendar Body -->
  <div class="flex-1 flex flex-col overflow-hidden">
    {#if view === 'agenda'}
      <!-- ===== AGENDA (liste du mois) ===== -->
      <div class="h-full overflow-y-auto custom-scrollbar">
        {#each agendaDays as day (day.date.toDateString())}
          <section>
            <h3 class="sticky top-0 z-10 px-4 py-2 text-body-sm font-semibold bg-surface-container-lowest border-b border-outline-variant {isToday(day.date) ? 'text-primary' : 'text-on-surface'}">
              {capitalize(day.date.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' }))}
              {#if isToday(day.date)}<span class="ml-1 text-2xs font-medium">· {m.cal_today()}</span>{/if}
            </h3>
            <ul>
              {#each day.events as event (event.type + event.id)}
                <li>
                  <button
                    type="button"
                    onclick={() => onEventClick(event)}
                    style="--evt: {typeColor(event.type)}"
                    class="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-container transition-colors"
                  >
                    <span class="w-24 shrink-0 text-2xs font-medium text-on-surface-variant">
                      {event.isAllDay ? m.cal_all_day() : `${formatTime(event.start)}${event.end ? ` – ${formatTime(event.end)}` : ''}`}
                    </span>
                    <span class="cal-dot w-2 h-2 rounded-full shrink-0"></span>
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
            <button type="button" class="btn btn-tonal btn-sm" onclick={() => onDateClick(new Date(Date.now() + 3600000))}>
              {m.cal_agenda_add()}
            </button>
          </div>
        {/each}
      </div>
    {:else if view === 'month'}
      <!-- ===== MONTH VIEW ===== -->
      <div class="grid grid-cols-7 h-full overflow-y-auto custom-scrollbar">
        <!-- Day headers -->
        {#each weekDaysShort as day}
          <div class="p-3 text-center text-xs font-semibold text-on-surface-variant border-b border-r border-outline-variant/10 last:border-r-0 bg-surface-container-lowest/50 sticky top-0 z-10">
            {day}
          </div>
        {/each}

        <!-- Day cells -->
        {#each calendarDays as { date, isCurrentMonth }}
          {@const dayEvents = getEventsForDate(date)}
          <div
            class="month-day min-h-27.5 p-1.5 border-b border-r border-outline-variant/10 last:border-r-0 hover:bg-surface-hover/20 transition-colors group relative select-none {isCurrentMonth ? '' : 'opacity-40'}"
            onpointerdown={(e) => handlePointerDown(date, e)}
            role="button"
            tabindex="0"
          >
            <!-- Selection highlight -->
            {#if isSelecting && selectionStart && selectionEnd}
              {@const startT = selectionStart.date.getTime()}
              {@const endT = selectionEnd.date.getTime()}
              {@const currentT = date.getTime()}
              {#if (currentT >= Math.min(startT, endT) && currentT <= Math.max(startT, endT))}
                <div class="absolute inset-0 bg-primary/10 border-2 border-primary/30 z-0"></div>
              {/if}
            {/if}

            <div class="flex items-center justify-between mb-1 px-0.5 relative z-10">
              <span class="text-2xs font-semibold {isToday(date) ? 'w-6 h-6 bg-primary text-white flex items-center justify-center rounded-full' : 'text-on-surface-variant'}">
                {date.getDate()}
              </span>
            </div>

            <div class="flex flex-col gap-0.5 overflow-hidden max-h-19 relative z-10">
              {#each dayEvents.slice(0, 3) as event}
                <button
                  onclick={(e) => { e.stopPropagation(); onEventClick(event); }}
                  onpointerdown={(e) => e.stopPropagation()}
                  style="--evt: {typeColor(event.type)}"
                  class="cal-evt w-full text-left px-1.5 py-0.5 rounded text-2xs truncate flex items-center gap-1 transition-all cursor-pointer"
                >
                  <span class="cal-dot w-1.5 h-1.5 rounded-full shrink-0"></span>
                  {#if !event.isAllDay}
                    <span class="text-on-surface-variant font-medium shrink-0">{formatTime(event.start)}</span>
                  {/if}
                  <span class="font-semibold text-on-surface truncate">{event.title}</span>
                </button>
              {/each}
              {#if dayEvents.length > 3}
                <button
                  onclick={(e) => { e.stopPropagation(); onDateClick(date); }}
                  onpointerdown={(e) => e.stopPropagation()}
                  class="w-full text-center py-0.5 text-2xs font-semibold text-primary hover:underline transition-colors"
                >
                  {m.cal_more({ n: dayEvents.length - 3 })}
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>

    {:else}
      <!-- ===== TIME VIEW (Day / Work Week / Week) ===== -->
      <div class="flex flex-col h-full overflow-hidden">
        <!-- Day column headers -->
        <div class="grid shrink-0 border-b border-outline-variant/20" style="grid-template-columns: 56px repeat({colCount}, 1fr)">
          <div class="border-r border-outline-variant/10"></div>
          {#each calendarDays as { date }}
            <div class="py-2.5 px-2 text-center border-r border-outline-variant/10 last:border-r-0 {isToday(date) ? 'bg-primary/5' : ''}">
              <p class="text-xs font-semibold text-on-surface-variant">{weekDaysShort[(date.getDay() + 6) % 7]}</p>
              <p class="text-lg font-bold {isToday(date) ? 'text-primary' : 'text-on-surface'} leading-tight">
                {#if isToday(date)}
                  <span class="inline-flex items-center justify-center w-8 h-8 bg-primary text-white rounded-full">{date.getDate()}</span>
                {:else}
                  {date.getDate()}
                {/if}
              </p>
            </div>
          {/each}
        </div>

        <!-- All-day events -->
        <div class="grid shrink-0 border-b border-outline-variant/20 bg-surface-container-lowest/30" style="grid-template-columns: 56px repeat({colCount}, 1fr)">
          <div class="px-1 py-1.5 text-2xs font-semibold text-on-surface-variant flex items-center justify-center border-r border-outline-variant/10">
            {m.cal_all_day()}
          </div>
          {#each calendarDays as { date }}
            {@const allDayEvents = getEventsForDate(date, 'allDay')}
            <div
              class="px-1 py-1 min-h-8 border-r border-outline-variant/10 last:border-r-0 space-y-0.5 overflow-hidden hover:bg-surface-hover/20 transition-colors cursor-pointer"
              onclick={() => onDateClick(date)}
              onkeydown={(e) => e.key === 'Enter' && onDateClick(date)}
              role="button"
              tabindex="0"
            >
              {#each allDayEvents.slice(0, 2) as event}
                <button
                  onclick={(e) => { e.stopPropagation(); onEventClick(event); }}
                  onpointerdown={(e) => e.stopPropagation()}
                  style="--evt: {typeColor(event.type)}"
                  class="cal-evt cal-evt--bar w-full text-left px-2 py-0.5 rounded text-2xs font-semibold truncate transition-all cursor-pointer"
                >
                  <span class="inline-flex items-center gap-1">
                    <Papicon icon={getEventIcon(event.type)} size={9} />
                    <span>{event.title}</span>
                  </span>
                </button>
              {/each}
              {#if allDayEvents.length > 2}
                <button
                  class="w-full text-center py-0.5 text-2xs font-semibold text-primary/60 hover:text-primary transition-colors"
                  onclick={() => onDateClick(date)}
                >
                  +{allDayEvents.length - 2}
                </button>
              {/if}
            </div>
          {/each}
        </div>

        <!-- Scrollable Time Grid -->
        <div bind:this={timeGridEl} class="flex-1 overflow-y-auto custom-scrollbar relative">
          <div class="grid relative" style="grid-template-columns: 56px repeat({colCount}, 1fr); min-height: 1440px;">
            <!-- Hour labels -->
            <div class="flex flex-col">
              {#each hours as hour}
                <div class="h-15 text-2xs font-semibold text-on-surface-variant/40 flex items-start justify-end pr-2 pt-0 border-r border-outline-variant/10 relative">
                  <span class="-mt-1.75">{hour.toString().padStart(2, '0')}:00</span>
                </div>
              {/each}
            </div>

            <!-- Day columns -->
            {#each calendarDays as { date }}
              {@const dayEvents = getEventsForDate(date)}
              <div
                class="day-column relative border-r border-outline-variant/10 last:border-r-0 h-full {isToday(date) ? 'bg-primary/2' : ''} transition-colors cursor-pointer select-none"
                onpointerdown={(e) => handlePointerDown(date, e)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const start = new Date(date);
                    start.setHours(9, 0, 0, 0);
                    onDateClick(start, new Date(start.getTime() + 30 * 60 * 1000));
                  }
                }}
                role="button"
                tabindex="0"
              >
                <!-- Hour grid lines -->
                {#each hours as _}
                  <div class="h-7.5 border-b border-outline-variant/4"></div>
                  <div class="h-7.5 border-b border-outline-variant/10"></div>
                {/each}

                <!-- Selection overlay -->
                {#if isSelecting && selectionStart && selectionEnd}
                  {@const startT = selectionStart.date.getTime()}
                  {@const endT = selectionEnd.date.getTime()}
                  {@const currentT = date.getTime()}
                  {#if (currentT >= Math.min(startT, endT) && currentT <= Math.max(startT, endT))}
                    {@const sMin = currentT === startT ? selectionStart.minutes : (currentT === endT ? selectionEnd.minutes : 0)}
                    {@const eMin = currentT === endT ? selectionEnd.minutes : (currentT === startT ? selectionStart.minutes : 1440)}
                    {@const displayTop = Math.min(sMin, eMin) / 1440 * 100}
                    {@const displayHeight = Math.abs(eMin - sMin) / 1440 * 100}
                    <div
                      class="absolute left-0 right-0 bg-primary/15 border-y-2 border-primary/50 z-10 pointer-events-none rounded-sm"
                      style="top: {displayTop}%; height: {displayHeight}%"
                    >
                      <div class="px-2 py-0.5 text-2xs font-semibold text-primary">
                        {Math.floor(Math.min(sMin, eMin) / 60)}:{(Math.min(sMin, eMin) % 60).toString().padStart(2, '0')} – {Math.floor(Math.max(sMin, eMin) / 60)}:{(Math.max(sMin, eMin) % 60).toString().padStart(2, '0')}
                      </div>
                    </div>
                  {/if}
                {/if}

                <!-- Timed events (Outlook left-border style) -->
                {#each getEventsForDate(date, 'timed') as event}
                  {@const styles = getEventStyles(event, dayEvents)}
                  <button
                    onclick={(e) => { e.stopPropagation(); onEventClick(event); }}
                    onpointerdown={(e) => e.stopPropagation()}
                    class="cal-evt cal-evt--bar absolute rounded-sm overflow-hidden transition-all hover:z-20 hover:shadow-lg hover:shadow-black/20 cursor-pointer"
                    style="--evt: {typeColor(event.type)}; top: {styles.top}%; height: {styles.height}%; left: calc({styles.left}% + 2px); width: calc({styles.width}% - 4px); min-height: 22px;"
                  >
                    <div class="px-2 py-1 h-full flex flex-col">
                      <span class="cal-evt__time text-2xs font-medium leading-none">
                        {formatTime(event.start)}{event.end ? ` – ${formatTime(event.end)}` : ''}
                      </span>
                      <span class="text-2xs font-semibold text-on-surface truncate leading-tight mt-0.5">{event.title}</span>
                      {#if event.staffName && styles.height > 4}
                        <span class="text-2xs text-on-surface-variant truncate mt-auto flex items-center gap-1">
                          {#if event.avatarUrl}
                            <img src={event.avatarUrl} alt="" class="w-3 h-3 rounded-full" />
                          {/if}
                          {event.staffName}
                        </span>
                      {/if}
                    </div>
                  </button>
                {/each}

                <!-- Current time indicator -->
                {#if isToday(date)}
                  {@const nowTop = getGlobalTimeTop()}
                  <div class="absolute -left-1.25 w-2.5 h-2.5 bg-error rounded-full z-30 shadow-sm" style="top: calc({nowTop}% - 5px)"></div>
                {/if}
              </div>
            {/each}

            <!-- Global red line for current time -->
            <div class="absolute right-0 h-0.5 bg-error/60 z-20 pointer-events-none" style="top: {getGlobalTimeTop()}%; left: 56px;"></div>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .calendar-container {
    user-select: none;
  }
  .cal-evt {
    background: color-mix(in srgb, var(--evt) 14%, transparent);
  }
  .cal-evt:hover {
    background: color-mix(in srgb, var(--evt) 24%, transparent);
  }
  .cal-evt--bar {
    border-left: 3px solid var(--evt);
  }
  .cal-evt__time {
    color: color-mix(in srgb, var(--evt) 75%, var(--color-on-surface));
  }
  .cal-dot {
    background: var(--evt);
  }
  .custom-scrollbar::-webkit-scrollbar {
    width: 6px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 10px;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  @media (max-width: 640px) {
    .calendar-container {
      height: 72dvh !important;
      min-height: 32rem !important;
      border-radius: 1rem;
    }

    .calendar-header {
      flex-wrap: wrap;
      gap: 0.75rem;
      padding: 0.75rem;
    }

    .calendar-header__leading {
      width: 100%;
      gap: 0.25rem;
    }

    .calendar-header__title {
      min-width: 0;
      margin-left: 0.25rem;
      overflow: hidden;
      font-size: 0.875rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .calendar-view-tabs {
      width: 100%;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .calendar-view-tabs::-webkit-scrollbar {
      display: none;
    }

    .calendar-view-tabs button {
      min-height: 2.25rem;
      flex: 1 0 auto;
      padding-right: 0.75rem;
      padding-left: 0.75rem;
    }

    .month-day {
      min-height: 5rem !important;
      padding: 0.25rem !important;
    }

    .month-day button {
      padding-right: 0.25rem !important;
      padding-left: 0.25rem !important;
    }

    .day-column > button {
      min-height: 1.75rem !important;
    }
  }
</style>
