ALTER TABLE mx_tools ADD COLUMN parent_tool_id INTEGER REFERENCES mx_tools (id);
ALTER TABLE mx_tool_movements ADD COLUMN with_movement_id INTEGER REFERENCES mx_tool_movements (id);
CREATE INDEX IF NOT EXISTS idx_mx_tools_parent ON mx_tools (parent_tool_id);
CREATE INDEX IF NOT EXISTS idx_mx_tool_movements_with ON mx_tool_movements (with_movement_id);
