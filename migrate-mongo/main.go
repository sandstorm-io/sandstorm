package main

import (
	"context"
	"encoding/binary"
	"flag"
	"os"
	"path/filepath"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

var (
	mongoPort  = flag.String("mongo-port", "", "Port on which mongo is listening")
	passwdFile = flag.String("passwd-file", "/var/mongo/passwd",
		"File storing the mongo user password")
	snapshotDir = flag.String("snapshot-dir", "",
		"Directory in which to store a temporary snapshot")
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

	chkfatal(os.MkdirAll(*snapshotDir, 0700))

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
	collectionNames, err := db.ListCollectionNames(ctx, bson.D{})
	chkfatal(err)
	for _, cname := range collectionNames {
		f, err := os.Create(filepath.Join(*snapshotDir, cname))
		chkfatal(err)

		c := db.Collection(cname)
		cur, err := c.Find(ctx, bson.D{})
		chkfatal(err)
		for cur.Next(ctx) {
			chkfatal(binary.Write(f, binary.LittleEndian, uint32(len(cur.Current))))
			_, err = f.Write(cur.Current[:])
			chkfatal(err)
		}
	}
}
