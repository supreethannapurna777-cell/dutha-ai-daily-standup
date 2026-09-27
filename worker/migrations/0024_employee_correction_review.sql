-- Preserve an immutable snapshot of the original stand-up and the manager's
-- reviewed values so each correction row is also its complete audit record.
ALTER TABLE employee_update_corrections ADD COLUMN original_tasks TEXT;
ALTER TABLE employee_update_corrections ADD COLUMN original_people_to_connect TEXT;
ALTER TABLE employee_update_corrections ADD COLUMN original_blockers TEXT;
ALTER TABLE employee_update_corrections ADD COLUMN original_dependencies TEXT;
ALTER TABLE employee_update_corrections ADD COLUMN original_expected_completion TEXT;
ALTER TABLE employee_update_corrections ADD COLUMN original_reply TEXT;
ALTER TABLE employee_update_corrections ADD COLUMN final_tasks TEXT;
ALTER TABLE employee_update_corrections ADD COLUMN final_people_to_connect TEXT;
ALTER TABLE employee_update_corrections ADD COLUMN final_blockers TEXT;
ALTER TABLE employee_update_corrections ADD COLUMN final_dependencies TEXT;
ALTER TABLE employee_update_corrections ADD COLUMN final_expected_completion TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_corrections_one_pending
ON employee_update_corrections (processed_update_id)
WHERE status = 'pending_review';
