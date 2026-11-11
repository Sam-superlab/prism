import * as SQLite from 'expo-sqlite';
import type { SqlDriver } from './store';

type Connection = Pick<SQLite.SQLiteDatabase, 'execAsync' | 'runAsync' | 'getAllAsync'>;
function driver(connection: Connection, transaction?: SQLite.SQLiteDatabase): SqlDriver {
  const result: SqlDriver = {
    exec: (sql) => connection.execAsync(sql),
    run: async (sql, ...values) => {
      await connection.runAsync(sql, values);
    },
    all: <T>(sql: string, ...values: (string | number | null)[]) => connection.getAllAsync<T>(sql, values),
    transaction: async (fn) => {
      if (!transaction) return fn(result);
      let value: unknown;
      await transaction.withExclusiveTransactionAsync(async (tx) => {
        value = await fn(driver(tx));
      });
      return value as Awaited<ReturnType<typeof fn>>;
    },
  };
  return result;
}
export async function openStoreDriver(account = 'personal'): Promise<SqlDriver> {
  const db = await SQLite.openDatabaseAsync(`prism-${account.replace(/[^a-zA-Z0-9-]/g, '')}.db`);
  return driver(db, db);
}
