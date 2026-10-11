export function timecode(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const whole = Math.floor(milliseconds / 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const parts = [
    String(minutes).padStart(2, "0"),
    String(whole % 60).padStart(2, "0"),
  ];
  if (hours) parts.unshift(String(hours));
  return (
    parts.join(":") +
    (milliseconds % 1000
      ? `.${String(milliseconds % 1000)
          .padStart(3, "0")
          .replace(/0+$/, "")}`
      : "")
  );
}
