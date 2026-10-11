/**
 * Placeholder for a module whose data has NO contract entity yet (lane 3
 * contract-requests, group ค): Net Profit, staff skills, AI coach, predictive
 * analytics, attendance… Rendering a clean reserved slot instead of a mock
 * number is what stops a demo value from being mistaken for a spec promise.
 *
 * The Thai sentence is the group-(ค) house style already used across the doc:
 * a fallback a stakeholder can read and that no code branches on.
 */
export function PlannedPlaceholder({ title }: { title: string }) {
  return (
    <div
      className="eco-card eco-planned"
      role="note"
      aria-label={`${title}: ข้อมูลอยู่ระหว่างรอ backend contract extension`}
    >
      <b>{title}</b>
      <p className="eco-planned__text">ข้อมูลตัวอย่าง — รอ backend contract extension</p>
    </div>
  );
}
