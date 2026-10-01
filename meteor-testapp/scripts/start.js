// Minimal Sandstorm launcher for the Mongo-free Meteor account test fixture.
process.env.PORT ||= "4000";
process.env.ROOT_URL ||= `http://127.0.0.1:${process.env.PORT}`;
require("/main.js");
