<script lang="ts" module>
  export { EVENT_TYPE_COLOR, CALENDAR_VIEWS, PHONE_VIEWS } from '@kotbo/ui';
  export type CalendarView = import('@kotbo/ui').CalendarView;
  // `raw` porte l'objet API brut, différent selon le type d'élément : @kotbo/ui le laisse `unknown`.
  export type CalendarEvent = Omit<import('@kotbo/ui').CalendarEvent, 'raw'> & { raw?: any };
</script>

<script lang="ts">
  import { Calendar as KotboCalendar } from '@kotbo/ui';

  let {
    view = $bindable<CalendarView>('week'),
    currentDate = $bindable(new Date()),
    events = [] as CalendarEvent[],
    selectedKey = null as string | null,
    showWeekend = 'auto' as 'auto' | 'always',
    onRangeChange,
    onEventClick,
    onSlotSelect,
    onEventMove = undefined,
    canMove = () => false,
    canResize = () => false,
  }: {
    view?: CalendarView;
    currentDate?: Date;
    events?: CalendarEvent[];
    selectedKey?: string | null;
    showWeekend?: 'auto' | 'always';
    onRangeChange: (start: Date, end: Date) => void;
    onEventClick: (event: CalendarEvent, anchor: DOMRect) => void;
    onSlotSelect: (start: Date, end: Date, anchor: DOMRect) => void;
    onEventMove?: (event: CalendarEvent, start: Date, end: Date) => void;
    canMove?: (event: CalendarEvent) => boolean;
    canResize?: (event: CalendarEvent) => boolean;
  } = $props();
</script>

<KotboCalendar
  bind:view
  bind:currentDate
  {events}
  {selectedKey}
  {showWeekend}
  {onRangeChange}
  {onEventClick}
  {onSlotSelect}
  {onEventMove}
  {canMove}
  {canResize}
/>
