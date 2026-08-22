-- 190 - THE MOVE-IN DATE TRAVELS WITH THE APPLICATION TARGET
--
-- A future unit could be shown by canonical availability, but an application
-- invitation could carry only the unit and space. The date used to decide that
-- the bed was offerable disappeared before submission, so the submission door
-- had to reject every future target. Preserve the date instead of rebuilding it
-- from a message, browser state, or the applicant's later preference.

alter table application_invitations
  add column if not exists intended_move_in date;

comment on column application_invitations.intended_move_in is
  'The staff-targeted move-in date evaluated against canonical availability when the invitation was prepared. It is lineage, not an applicant preference.';

alter table lease_applications
  add column if not exists intended_move_in date;

comment on column lease_applications.intended_move_in is
  'The move-in target inherited from the invitation. Applicant desired_move_in remains separately captured; proposed lease dates remain governed structured terms.';
