# Appointment calendar implementation status

## User-facing changes

- Student and staff workspaces now support day/week calendar views, previous/next/today navigation, counselor, location, time-range, and appointment-status filters.
- Counselors can manage only their own availability and appointments; school administrators and professional leads retain school-scoped management. Students only see open slots and their own appointments.
- Students may request, cancel, or reschedule future appointments. A reschedule releases the previous slot and returns the new slot to `requested` so a counselor must confirm the changed time. Counselors can confirm, cancel, record completion, and mark no-show after the scheduled end time.
- Calendar and appointment list output includes waiting duration, configured confirmation-delay exceptions, and notification retry/dead-letter exceptions. Closure/no-show remains an explicit staff action; no appointment is automatically marked attended or missed.
- Browser-local time is displayed with its IANA time-zone name and UTC offset. The API requires an explicit time-zone offset for slot creation/filter timestamps and stores ISO timestamps; `datetime-local` inputs are converted to ISO before submission.

## Notification workflow

- Booking, confirmation, rescheduling, cancellation, completion, and no-show create outbox events for both the student and responsible counselor. Rescheduling also includes the previous counselor when ownership changes. Notification context contains schedule metadata only; appointment notes are never passed to the notification adapter.
- After confirmation, reminder outbox events are scheduled for 24 hours, 1 hour, and 15 minutes before the appointment when those times are still in the future. A changed or cancelled appointment cancels pending reminders for its previous schedule. The event ID is the adapter idempotency key.
- Notification failures are retried by the existing outbox policy; retrying and dead-letter events surface on the appointment exception queue. Requested appointments that exceed `CAMPMIND_APPOINTMENT_CONFIRMATION_SLA_MINUTES` (default 1440 minutes; accepted range 15–10080) also appear there. This is an operational routing threshold, not a response-time promise.
- This repository is a development/reference implementation. The local notification adapter is a no-op reference adapter. A production deployment still needs an approved notification provider that honors the `recipientIds` and schedule context, plus a regularly scheduled worker run (for example, every minute for near-real-time reminder delivery). No service was deployed or provider configured as part of this change.
