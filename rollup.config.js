import typescript from 'rollup-plugin-typescript2';

export default {
    input: 'lib/sepa.ts',
    output: {
        file: 'lib/sepa.js',
        format: 'cjs'
    },
    plugins: [
        typescript()
    ]
};