module.exports = function(grunt) {
  grunt.loadNpmTasks("grunt-webfont");


  grunt.initConfig({
    webfont: {
      icons: {
        src: "./*.svg",
        dest: "../shell/public/icons",
        destCss: "../shell/client/styles",
        options: {
          font: "icons",
          engine: "fontforge",
          autoHint: false,
          htmlDemo: false,
          relativeFontPath: "/icons/",
          stylesheet: "scss",
          templateOptions: {
            classPrefix: "icon-",
            mixinPrefix: "icon-",
          },
        },
      },
    },
  });

  grunt.registerTask("default", ["webfont"]);
};
