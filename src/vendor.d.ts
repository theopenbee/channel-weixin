declare module "qrcode-terminal" {
  interface Options {
    small?: boolean;
  }
  const qrcode: {
    generate(text: string, options?: Options, callback?: (output: string) => void): void;
  };
  export default qrcode;
}
