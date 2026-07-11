# Data Model

Google Sheets is used as the database.
Each tab acts like a table.

## Employees

Stores Telegram users and employee status.

| Column | Description |
| --- | --- |
| `Telegram_ID` | Telegram numeric user ID |
| `Name` | First name and last name from Telegram |
| `Username` | Telegram username |
| `Status` | `active` or inactive status |
| `Cycle_Start` | Current salary cycle start |
| `Registered_At` | First registration timestamp |
| `Language` | `zh`, `en`, or `vi` |

## Pending_Income

Stores income submissions waiting for admin decision.

| Column | Description |
| --- | --- |
| `Request_ID` | Generated request ID |
| `Telegram_ID` | Employee ID |
| `Income` | Submitted income amount |
| `Fine` | Submitted fine amount |
| `Submitted_At` | Submission timestamp |
| `Status` | `PENDING`, `REJECTING`, `APPROVED`, or `REJECTED` |
| `Admin_ID` | Admin handling the request |
| `Decided_At` | Decision timestamp |

## Income_Records

Stores approved income and attendance fine records.

| Column | Description |
| --- | --- |
| `Record_ID` | Generated record ID |
| `Telegram_ID` | Employee ID |
| `Income` | Approved income amount |
| `Fine` | Approved or system fine |
| `Source` | `MANUAL`, `ATTENDANCE_LATE`, or `ATTENDANCE_EARLY` |
| `Submitted_At` | Original submission timestamp |
| `Approved_At` | Approval timestamp |
| `Admin_ID` | Approving admin or `SYSTEM` |

## Rejected_Income

Stores rejected income submissions and reasons.

## Salary_Requests

Stores salary payout requests and admin decisions.

| Column | Description |
| --- | --- |
| `Request_ID` | Generated request ID |
| `Telegram_ID` | Employee ID |
| `Amount_Snapshot` | Total at request time |
| `Requested_At` | Request timestamp |
| `Status` | `PENDING`, `REJECTING`, `APPROVED`, or `REJECTED` |
| `Admin_ID` | Admin handling the request |
| `Decided_At` | Decision timestamp |
| `Reason` | Rejection reason |

## Salary_History

Stores approved salary payout records.

## Attendance

Stores check-in and checkout records.

| Column | Description |
| --- | --- |
| `Record_ID` | Generated attendance ID |
| `Telegram_ID` | Employee ID |
| `Business_Date` | Work date calculated by shift logic |
| `Type` | `CHECKIN` or `CHECKOUT` |
| `Timestamp` | Actual event timestamp |
| `Latitude` | Shared location latitude |
| `Longitude` | Shared location longitude |
| `Late` | Whether check-in was late |
| `Early_Leave` | Whether checkout was early |
| `Fine` | Fine amount |

## Admin_Audit_Log

Stores admin actions and unauthorized callback attempts.

## Settings

Stores editable runtime settings.

## Error_Log

Stores caught runtime errors and Telegram API failures.
