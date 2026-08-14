export function createD1(database, hooks = {}) {
  function prepare(sql) {
    let params = [];
    return {
      _sql: sql,
      bind(...values) {
        params = values;
        return this;
      },
      async first() {
        if (hooks.beforeFirst) await hooks.beforeFirst(sql, params);
        const row = database.prepare(sql).get(...params) || null;
        if (hooks.afterFirst) await hooks.afterFirst(sql, row);
        return row;
      },
      async all() {
        if (hooks.beforeAll) await hooks.beforeAll(sql, params);
        return { results: database.prepare(sql).all(...params) };
      },
      async run() {
        if (hooks.beforeRun) await hooks.beforeRun(sql, params);
        return this._run();
      },
      _run() {
        const result = database.prepare(sql).run(...params);
        return {
          success: true,
          meta: {
            changes: hooks.reportedChanges === undefined
              ? Number(result.changes)
              : Number(hooks.reportedChanges)
          }
        };
      }
    };
  }

  return {
    prepare,
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) {
          if (hooks.beforeBatchStatement) {
            await hooks.beforeBatchStatement(statement._sql);
          }
          results.push(statement._run());
        }
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    }
  };
}
