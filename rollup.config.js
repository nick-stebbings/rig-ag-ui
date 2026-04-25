import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';

export default {
  input: 'src/app.ts',
  output: {
    dir: 'dist',
    format: 'esm',
    sourcemap: true,
    preserveModules: true,
    preserveModulesRoot: 'src',
  },
  external: [
    // Node built-ins
    'node:http',
    'node:https',
    'node:stream',
    'node:buffer',
    'node:events',
    'node:url',
    'node:util',
    'node:path',
    'node:fs',
    'node:crypto',
    // Dependencies (don't bundle)
    '@apollo/server',
    '@graphql-tools/schema',
    'axios',
    'cors',
    'dotenv',
    'eventemitter3',
    'express',
    'express-rate-limit',
    'graphql',
    'graphql-subscriptions',
    'graphql-tag',
    'graphql-ws',
    'helmet',
    'rxjs',
    'uuid',
    'winston',
    'ws',
    'zod',
  ],
  plugins: [
    typescript({
      tsconfig: './tsconfig.json',
      declaration: false,
      declarationMap: false,
      outDir: './dist',
      compilerOptions: {
        sourceMap: true,
      },
    }),
    resolve({
      preferBuiltins: true,
    }),
    commonjs(),
    json(),
  ],
};
