package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

var (
	mongoPort  = flag.String("mongo-port", "", "Port on which mongo is listening")
	passwdFile = flag.String("passwd-file", "/var/mongo/passwd",
		"File storing the mongo user password")
)

func chkfatal(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	flag.Parse()

	passwd, err := os.ReadFile(*passwdFile)
	chkfatal(err)

	ctx := context.Background()
	client, err := mongo.Connect(
		ctx,
		options.Client().ApplyURI(
			"mongodb://sandstorm:"+string(passwd)+"@127.0.0.1:"+*mongoPort,
		),
	)
	chkfatal(err)
	defer client.Disconnect(ctx)
	db := client.Database("meteor")
	names, err := db.ListCollectionNames(ctx, bson.D{})
	chkfatal(err)
	for _, name := range names {
		fmt.Println(name)
	}
}
