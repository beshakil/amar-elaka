const timeFormat = new Intl.DateTimeFormat('bn-BD', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Dhaka',
});

/** "১৪:০৫": a message's time in Bangladesh, Bengali digits (the thread and the inbox). */
export function chatTime(iso: string): string {
  return timeFormat.format(new Date(iso));
}
