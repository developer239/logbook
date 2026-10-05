import { RULES_LABELLER } from '@log-book/warehouse'

// A record's label field, from the rules (`=`) or from the model that labelled it last (`<>`). A lookup by the label
// table's key, one record at a time: joining records to a derived table of all labels is far slower.
export const labelSql = (recordType: string, recordId: string, field: string, rules: '=' | '<>'): string =>
  `(SELECT l.value FROM label l WHERE l.record_type = '${recordType}' AND l.record_id = ${recordId}
     AND l.labeller ${rules} '${RULES_LABELLER}' AND l.name = '${field}' ORDER BY l.labelled_at DESC LIMIT 1)`
