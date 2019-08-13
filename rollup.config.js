import typescript from 'rollup-plugin-typescript2';
import { uglify } from "rollup-plugin-uglify";

export default {
    input: 'lib/sepa.ts',
    output: {
        file: 'lib/sepa.min.js',
        format: 'cjs'
    },
    plugins: [
        typescript(),
        uglify()
    ]
};