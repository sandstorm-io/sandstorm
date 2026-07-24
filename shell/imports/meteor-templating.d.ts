declare module "meteor/templating" {
  import { Blaze } from "meteor/blaze";

  const Template: Blaze.TemplateStatic & Record<string, Blaze.Template>;

  export { Template };
}
