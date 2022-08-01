package main

import (
	"context"
	"flag"
	"fmt"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

var (
	mongoPort = flag.String("mongo-port", "", "Port on which mongo is listening")
)

func chkfatal(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	flag.Parse()
	ctx := context.Background()
	client, err := mongo.Connect(
		ctx,
		options.Client().ApplyURI("mongodb://127.0.0.1:"+*mongoPort),
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
